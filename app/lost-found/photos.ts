import type { AttractionCategory } from "../berlin-transit/attractions";
import { dist, type LL } from "../berlin-transit/geo";
import type { SearchItem } from "./data";

// Bias matching toward recognizable sights: a landmark slightly farther should
// beat an obscure artwork right next to it, but a much-closer sight still wins.
const CATEGORY_WEIGHT: Record<AttractionCategory, number> = {
  landmark: 0.6,
  castle: 0.7,
  museum: 0.72,
  viewpoint: 0.85,
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
const EXIF_CONCURRENCY = 4;

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
export async function extractPhotoPoints(files: File[]): Promise<ExtractResult> {
  const { default: exifr } = await import("exifr");
  const parsed: Array<PhotoPoint | null> = Array(files.length).fill(null);
  let nextIndex = 0;

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
        const metadataOptions = {
          gps: true,
          exif: { pick: ["DateTimeOriginal"] },
          mergeOutput: true,
          translateKeys: true,
          reviveValues: true,
          // EXIF normally lives near the start of the file. Chunked reads avoid
          // decoding an entire 20–50 MB phone photo just to obtain a few tags.
          chunked: true,
          firstChunkSize: 65_536,
          chunkSize: 65_536,
          chunkLimit: 5,
        } as Parameters<typeof exifr.parse>[1];
        const meta = (await exifr.parse(
          file,
          metadataOptions
        )) as Record<string, unknown> | undefined;
        if (
          !meta ||
          typeof meta.latitude !== "number" ||
          typeof meta.longitude !== "number"
        ) {
          continue;
        }
        parsed[index] = {
          lat: meta.latitude,
          lng: meta.longitude,
          time: captureTime(meta),
        };
      } catch {
        // unreadable / no EXIF — skip this file
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(EXIF_CONCURRENCY, files.length) }, () => worker())
  );
  const points = parsed.filter((point): point is PhotoPoint => point !== null);
  return { points, total: files.length, withGps: points.length };
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
