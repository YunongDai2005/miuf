import type { AttractionCategory } from "../berlin-transit/attractions";
import { dist, type LL } from "../berlin-transit/geo";
import type { SearchItem } from "./data";

// Bias matching toward recognizable sights: a landmark slightly farther should
// beat an obscure artwork right next to it, but a much-closer sight still wins.
const CATEGORY_WEIGHT: Record<AttractionCategory, number> = {
  landmark: 0.6,
  castle: 0.7,
  museum: 0.72,
  // A photograph taken inside a venue is strong evidence of having been there,
  // and these are the places a traveller can actually name afterwards.
  venue: 0.72,
  theatre: 0.74,
  stadium: 0.75,
  gallery: 0.78,
  cinema: 0.82,
  viewpoint: 0.85,
  library: 0.88,
  leisure: 0.9,
  ruins: 1.0,
  memorial: 1.15,
  artwork: 1.3,
};

function weightFor(category?: AttractionCategory): number {
  return category ? CATEGORY_WEIGHT[category] ?? 1 : 1;
}

/** A geotagged moment pulled from one photo — never leaves the device. */
export interface PhotoPoint {
  lat: number;
  lng: number;
  time: number | null; // epoch ms from EXIF DateTimeOriginal, if present
}

export interface ExtractResult {
  points: PhotoPoint[];
  total: number; // photos the traveller picked
  withGps: number; // how many carried a location
}

export const DEFAULT_PHOTO_MERGE_RADIUS_M = 300;
export const DEFAULT_DEDUPE_WINDOW_MS = 60_000;
const EXIF_MAX_CONCURRENCY = 12;

/**
 * How many photos to read EXIF from at once. Reading EXIF is I/O-bound (small
 * chunked slice reads), so we oversubscribe the cores a little, but cap it so a
 * 100+ photo day can't spawn a read storm on a phone.
 */
function exifConcurrency(fileCount: number): number {
  const hardware =
    typeof navigator !== "undefined" &&
    typeof navigator.hardwareConcurrency === "number" &&
    navigator.hardwareConcurrency > 0
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(1, Math.min(EXIF_MAX_CONCURRENCY, hardware * 2, fileCount));
}

/** Options for {@link extractPhotoPoints}. */
export interface ExtractOptions {
  /** Reports processed/total as EXIF reads finish, for progress UI. */
  onProgress?: (done: number, total: number) => void;
}

/** A user-visible stop reconstructed from one or more nearby photos. */
export interface PhotoAnchor {
  id: string;
  point: LL;
  time: number | null;
  venue: SearchItem | null;
  distanceM: number | null;
  photoCount: number;
}

/**
 * Read EXIF GPS + capture time from the picked photos, entirely in the browser.
 * `exifr` is imported dynamically so it only loads client-side (and never during
 * SSR). GPS and time are read in one pass, with bounded concurrency so a phone
 * stays responsive. The File objects never leave the device.
 */
export async function extractPhotoPoints(
  files: File[],
  { onProgress }: ExtractOptions = {}
): Promise<ExtractResult> {
  const { default: exifr } = await import("exifr");
  const parsed: Array<PhotoPoint | null> = Array(files.length).fill(null);
  let nextIndex = 0;
  let processed = 0;

  // Report at most ~50 times so a big day doesn't thrash React re-renders.
  const progressStep = Math.max(1, Math.ceil(files.length / 50));
  const reportProgress = () => {
    processed += 1;
    if (
      onProgress &&
      (processed === files.length || processed % progressStep === 0)
    ) {
      onProgress(processed, files.length);
    }
  };

  // Built once, not per file: EXIF normally lives near the start of the file,
  // so chunked reads avoid decoding an entire 20–50 MB phone photo for a few tags.
  const metadataOptions = {
    gps: true,
    exif: { pick: ["DateTimeOriginal"] },
    mergeOutput: true,
    translateKeys: true,
    reviveValues: true,
    chunked: true,
    firstChunkSize: 65_536,
    chunkSize: 65_536,
    chunkLimit: 5,
  } as Parameters<typeof exifr.parse>[1];

  const captureTime = (meta: Record<string, unknown>): number | null => {
    // Some exifr builds keep DateTimeOriginal under its numeric EXIF tag.
    const value = meta.DateTimeOriginal ?? meta["36867"];
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
    if (typeof value !== "string") return null;
    const match = value.match(
      /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/
    );
    if (!match) return null;
    const date = new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6] ?? 0)
    );
    return Number.isNaN(date.getTime()) ? null : date.getTime();
  };

  const worker = async () => {
    while (nextIndex < files.length) {
      const index = nextIndex++;
      const file = files[index];
      try {
        const meta = (await exifr.parse(file, metadataOptions)) as
          | Record<string, unknown>
          | undefined;
        if (
          meta &&
          typeof meta.latitude === "number" &&
          typeof meta.longitude === "number"
        ) {
          parsed[index] = {
            lat: meta.latitude,
            lng: meta.longitude,
            time: captureTime(meta),
          };
        }
      } catch {
        // unreadable / no EXIF — skip this file
      } finally {
        reportProgress();
      }
    }
  };

  await Promise.all(
    Array.from({ length: exifConcurrency(files.length) }, () => worker())
  );
  const points = parsed.filter((point): point is PhotoPoint => point !== null);
  return { points, total: files.length, withGps: points.length };
}

const BERLIN_DAY_PARTS = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Berlin calendar day (YYYY-MM-DD) for an epoch ms, or null when untimed. */
export function berlinDayKey(time: number | null): string | null {
  if (time == null) return null;
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return null;
  const parts = BERLIN_DAY_PARTS.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  const year = get("year");
  const month = get("month");
  const day = get("day");
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

/** Human label for a YYYY-MM-DD Berlin day key, e.g. "Sun, 20 Jul 2026". */
export function formatBerlinDay(dayKey: string): string {
  const [year, month, day] = dayKey.split("-").map(Number);
  if (!year || !month || !day) return dayKey;
  // Noon UTC keeps the weekday correct regardless of the viewer's timezone.
  const date = new Date(Date.UTC(year, month - 1, day, 12));
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

/** GPS photos grouped by the Berlin calendar day they were taken. */
export interface PhotoDay {
  day: string | null; // YYYY-MM-DD, or null when capture time is unknown
  points: PhotoPoint[];
  count: number;
}

/** Bucket points into Berlin calendar days, real days first (ascending). */
export function groupPhotoDays(points: PhotoPoint[]): PhotoDay[] {
  const UNKNOWN = "";
  const byDay = new Map<string, PhotoPoint[]>();
  for (const point of points) {
    const key = berlinDayKey(point.time) ?? UNKNOWN;
    const bucket = byDay.get(key);
    if (bucket) bucket.push(point);
    else byDay.set(key, [point]);
  }
  const days = [...byDay.entries()].map(([key, dayPoints]) => ({
    day: key === UNKNOWN ? null : key,
    points: dayPoints,
    count: dayPoints.length,
  }));
  days.sort((a, b) => {
    if (a.day == null) return 1;
    if (b.day == null) return -1;
    return a.day < b.day ? -1 : a.day > b.day ? 1 : 0;
  });
  return days;
}

/** Keep only timed points inside an inclusive Berlin calendar-day window. */
export function filterPhotoPointsByDateWindow(
  points: PhotoPoint[],
  start: string,
  end: string
): PhotoPoint[] {
  const lower = start <= end ? start : end;
  const upper = start <= end ? end : start;
  return points.filter((point) => {
    const day = berlinDayKey(point.time);
    return day != null && day >= lower && day <= upper;
  });
}

/**
 * Drop near-duplicate burst frames: after ordering by capture time, skip any
 * photo taken within `windowMs` of the previous kept one. Untimed photos carry
 * no basis for de-duplication, so they are always kept.
 */
export function dedupeByTime(
  points: PhotoPoint[],
  windowMs = DEFAULT_DEDUPE_WINDOW_MS
): PhotoPoint[] {
  const timed = points
    .filter((point): point is PhotoPoint & { time: number } => point.time != null)
    .sort((a, b) => a.time - b.time);
  const untimed = points.filter((point) => point.time == null);
  const kept: PhotoPoint[] = [];
  let lastKept: number | null = null;
  for (const point of timed) {
    if (lastKept != null && point.time - lastKept < windowMs) continue;
    kept.push(point);
    lastKept = point.time;
  }
  return [...kept, ...untimed];
}

function orderedPoints(points: PhotoPoint[]) {
  return [...points].sort((a, b) => {
    if (a.time == null) return b.time == null ? 0 : 1;
    if (b.time == null) return -1;
    return a.time - b.time;
  });
}

function nearestVenue(
  point: LL,
  venues: SearchItem[],
  radiusM: number
): { venue: SearchItem; distanceM: number } | null {
  let best: SearchItem | null = null;
  let bestDistanceM = Infinity;
  let bestScore = Infinity;
  for (const venue of venues) {
    if (!venue.point) continue;
    const distanceM = dist(point, venue.point);
    if (distanceM > radiusM) continue;
    const score = distanceM * weightFor(venue.category);
    if (score < bestScore) {
      bestScore = score;
      bestDistanceM = distanceM;
      best = venue;
    }
  }
  return best ? { venue: best, distanceM: bestDistanceM } : null;
}

/**
 * Build ordered route anchors while retaining coordinates and capture time.
 * Consecutive photos within `mergeRadiusM` collapse before venue matching, so a
 * cluster is compared with nearby sights and route geometry only once.
 */
export function reconstructPhotoAnchors(
  points: PhotoPoint[],
  venues: SearchItem[],
  radiusM = 220,
  mergeRadiusM = DEFAULT_PHOTO_MERGE_RADIUS_M
): PhotoAnchor[] {
  const anchors: PhotoAnchor[] = [];

  for (const photo of orderedPoints(points)) {
    const point: LL = [photo.lat, photo.lng];
    const previous = anchors.at(-1);

    if (previous && dist(previous.point, point) <= mergeRadiusM) {
      const previousCount = previous.photoCount;
      previous.point = [
        (previous.point[0] * previousCount + point[0]) / (previousCount + 1),
        (previous.point[1] * previousCount + point[1]) / (previousCount + 1),
      ];
      previous.photoCount += 1;
      if (previous.time == null) previous.time = photo.time;
      continue;
    }

    anchors.push({
      id: `photo-anchor-${anchors.length + 1}`,
      point,
      time: photo.time,
      venue: null,
      distanceM: null,
      photoCount: 1,
    });
  }

  for (const anchor of anchors) {
    const match = nearestVenue(anchor.point, venues, radiusM);
    anchor.venue = match?.venue ?? null;
    anchor.distanceM = match?.distanceM ?? null;
  }

  return anchors;
}
