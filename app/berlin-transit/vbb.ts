import {
  dist,
  pointToPolyline,
  pointToSegment,
  polylineLength,
  resample,
  type LL,
} from "./geo";
import type { TransitLine, TransitMode, TransitStop } from "./transit";

export type ModeFilter = Record<TransitMode, boolean>;

export interface LiveJourneyLeg {
  id: string;
  walking: boolean;
  lineRef: string | null;
  lineId: string | null;
  mode: TransitMode | null;
  direction: string | null;
  originName: string;
  destinationName: string;
  departure: string;
  arrival: string;
  delayMinutes: number | null;
  polyline: LL[];
  color: string;
  textColor: string;
}

export interface LiveJourneyCandidate {
  id: string;
  legs: LiveJourneyLeg[];
  polyline: LL[];
  departure: string;
  arrival: string;
  durationMinutes: number;
  transfers: number;
  similarity: number;
  coverage: number;
  meanDistanceM: number;
  realtime: boolean;
  source: "live";
  viaStopName: string | null;
  checkpointCount: number;
}

export class VbbNoMatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VbbNoMatchError";
  }
}

export class VbbUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VbbUnavailableError";
  }
}

interface VbbPlace {
  id?: string;
  name?: string;
  location?: { latitude?: number; longitude?: number };
}

interface VbbLine {
  id?: string;
  name?: string;
  product?: string;
}

interface VbbLeg {
  walking?: boolean;
  origin?: VbbPlace;
  destination?: VbbPlace;
  departure?: string;
  plannedDeparture?: string;
  arrival?: string;
  plannedArrival?: string;
  direction?: string;
  line?: VbbLine;
  polyline?: {
    features?: Array<{ geometry?: { coordinates?: unknown } }>;
  };
}

interface VbbJourney {
  legs?: VbbLeg[];
}

interface VbbResponse {
  journeys?: VbbJourney[];
}

const API_URL = "https://v6.vbb.transport.rest/journeys";
const MIN_PLAUSIBLE_SIMILARITY = 30;
const MIN_PLAUSIBLE_COVERAGE = 0.2;
const MAX_TRACE_SEGMENTS = 5;

const MODE_COLORS: Record<TransitMode, string> = {
  subway: "#0067B1",
  light_rail: "#008D4F",
  tram: "#D71920",
  bus: "#7A3E93",
  rail: "#C7007F",
  ferry: "#1677A6",
};

function productToMode(product?: string): TransitMode | null {
  switch (product) {
    case "subway":
      return "subway";
    case "suburban":
      return "light_rail";
    case "tram":
      return "tram";
    case "bus":
      return "bus";
    case "regional":
    case "express":
      return "rail";
    case "ferry":
      return "ferry";
    default:
      return null;
  }
}

export function formatDateTimeLocal(date: Date): string {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}T${value.hour}:${value.minute}`;
}

/** Interpret a datetime-local value as Berlin time even when the viewer is abroad. */
export function berlinLocalToIso(value: string): string {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) throw new Error("无效的柏林当地时间");
  const requestedUtc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5])
  );
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const offsetAt = (timestamp: number) => {
    const parts = Object.fromEntries(
      formatter.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value])
    );
    const representedUtc = Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour),
      Number(parts.minute),
      Number(parts.second)
    );
    return representedUtc - timestamp;
  };
  let timestamp = requestedUtc - offsetAt(requestedUtc);
  timestamp = requestedUtc - offsetAt(timestamp);
  return new Date(timestamp).toISOString();
}

export function toApiStopId(stopId: string): string {
  return stopId.split(":").at(-1) ?? stopId;
}

function placePoint(place?: VbbPlace): LL | null {
  const lat = place?.location?.latitude;
  const lng = place?.location?.longitude;
  return typeof lat === "number" && typeof lng === "number" ? [lat, lng] : null;
}

function polylinePoints(leg: VbbLeg): LL[] {
  const points: LL[] = [];
  for (const feature of leg.polyline?.features ?? []) {
    const coordinates = feature.geometry?.coordinates;
    if (
      Array.isArray(coordinates) &&
      coordinates.length >= 2 &&
      typeof coordinates[0] === "number" &&
      typeof coordinates[1] === "number"
    ) {
      points.push([coordinates[1], coordinates[0]]);
    }
  }
  if (points.length >= 2) return points;
  const origin = placePoint(leg.origin);
  const destination = placePoint(leg.destination);
  return origin && destination ? [origin, destination] : [];
}

function appendPoints(target: LL[], points: LL[]) {
  for (const point of points) {
    if (!target.length || dist(target[target.length - 1], point) > 1) target.push(point);
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function decimate(points: LL[], maxPoints = 160): LL[] {
  if (points.length <= maxPoints) return points;
  const output: LL[] = [];
  for (let index = 0; index < maxPoints; index++) {
    output.push(points[Math.round((index / (maxPoints - 1)) * (points.length - 1))]);
  }
  return output;
}

function discreteFrechet(a: LL[], b: LL[]): number {
  if (!a.length || !b.length) return Infinity;
  let previous = Array<number>(b.length).fill(Infinity);
  for (let i = 0; i < a.length; i++) {
    const current = Array<number>(b.length).fill(Infinity);
    for (let j = 0; j < b.length; j++) {
      const distance = dist(a[i], b[j]);
      if (i === 0 && j === 0) current[j] = distance;
      else {
        current[j] = Math.max(
          distance,
          Math.min(previous[j] ?? Infinity, current[j - 1] ?? Infinity, previous[j - 1] ?? Infinity)
        );
      }
    }
    previous = current;
  }
  return previous[b.length - 1];
}

export function scoreJourneyGeometry(drawn: LL[], candidate: LL[]) {
  if (drawn.length < 2 || candidate.length < 2) {
    return { similarity: 0, coverage: 0, meanDistanceM: Infinity };
  }
  const drawnSamples = decimate(resample(drawn, 75));
  const candidateSamples = decimate(resample(candidate, 75));
  const distances = drawnSamples.map((point) => pointToPolyline(point, candidateSamples));
  const coverage = distances.filter((distance) => distance <= 250).length / distances.length;
  const meanDistanceM = distances.reduce((sum, distance) => sum + distance, 0) / distances.length;
  const frechet = discreteFrechet(drawnSamples, candidateSamples);
  const drawnLength = polylineLength(drawnSamples);
  const candidateLength = polylineLength(candidateSamples);
  const lengthRatio = Math.min(drawnLength, candidateLength) / Math.max(drawnLength, candidateLength, 1);
  const similarity = clamp(
    100 *
      (coverage * 0.45 +
        Math.exp(-meanDistanceM / 250) * 0.25 +
        Math.exp(-frechet / 600) * 0.2 +
        lengthRatio * 0.1),
    0,
    100
  );
  return { similarity, coverage, meanDistanceM };
}

interface TraceSpan {
  start: number;
  end: number;
  priority: number;
  splitAt: number;
}

function measureTraceSpan(samples: LL[], start: number, end: number): TraceSpan {
  const section = samples.slice(start, end + 1);
  const length = polylineLength(section);
  let maxDeviation = 0;
  let splitAt = Math.round((start + end) / 2);
  for (let index = start + 1; index < end; index++) {
    const deviation = pointToSegment(samples[index], samples[start], samples[end]);
    if (deviation > maxDeviation) {
      maxDeviation = deviation;
      splitAt = index;
    }
  }
  if (maxDeviation < 1_400 && length > 15_000) {
    splitAt = Math.round((start + end) / 2);
  }
  return {
    start,
    end,
    priority: Math.max(maxDeviation / 1_400, length / 15_000),
    splitAt,
  };
}

/**
 * Split a long or looping trace into ordered chunks. A single VBB journey
 * request only understands start/end and at most one via, which is not enough
 * for the multi-turn trace shown in the reported failure.
 */
export function splitTrace(drawn: LL[], maxSegments = MAX_TRACE_SEGMENTS): LL[][] {
  const samples = resample(drawn, 250);
  if (samples.length < 3) return [drawn];
  const boundaries = new Set([0, samples.length - 1]);

  while (boundaries.size - 1 < maxSegments) {
    const ordered = [...boundaries].sort((a, b) => a - b);
    const spans = ordered
      .slice(0, -1)
      .map((start, index) => measureTraceSpan(samples, start, ordered[index + 1]))
      .filter((span) => span.end - span.start >= 2)
      .sort((a, b) => b.priority - a.priority);
    const next = spans[0];
    if (!next || next.priority <= 1) break;
    boundaries.add(next.splitAt);
  }

  const ordered = [...boundaries].sort((a, b) => a - b);
  return ordered.slice(0, -1).map((start, index) => samples.slice(start, ordered[index + 1] + 1));
}

function uniqueStops(lines: TransitLine[]): TransitStop[] {
  const stops = new Map<string, TransitStop>();
  for (const line of lines) {
    for (const stop of line.stops) stops.set(stop.id, stop);
  }
  return [...stops.values()];
}

export function findViaStop(drawn: LL[], lines: TransitLine[]): TransitStop | null {
  const samples = resample(drawn, 100);
  if (samples.length < 5) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  let detourPoint: LL | null = null;
  let detourDistance = 350;
  const start = Math.floor(samples.length * 0.2);
  const end = Math.ceil(samples.length * 0.8);
  for (let index = start; index < end; index++) {
    const distance = pointToSegment(samples[index], first, last);
    if (distance > detourDistance) {
      detourDistance = distance;
      detourPoint = samples[index];
    }
  }
  if (!detourPoint) return null;

  let nearest: TransitStop | null = null;
  let nearestDistance = 600;
  for (const stop of uniqueStops(lines)) {
    if (dist(stop.point, first) < 650 || dist(stop.point, last) < 650) continue;
    const distance = dist(stop.point, detourPoint);
    if (distance < nearestDistance) {
      nearest = stop;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function lineStyle(ref: string | null, mode: TransitMode | null, lines: TransitLine[]) {
  const match = ref && mode ? lines.find((line) => line.mode === mode && line.ref === ref) : null;
  return {
    lineId: match?.id ?? (ref && mode ? `${mode}:${ref}` : null),
    color: match?.color ?? (mode ? MODE_COLORS[mode] : "#78716C"),
    textColor: match?.textColor ?? "#FFFFFF",
  };
}

function parseLeg(leg: VbbLeg, index: number, lines: TransitLine[]): LiveJourneyLeg | null {
  const walking = Boolean(leg.walking || !leg.line);
  const mode = walking ? null : productToMode(leg.line?.product);
  if (!walking && !mode) return null;
  const lineRef = walking ? null : leg.line?.name ?? null;
  const style = lineStyle(lineRef, mode, lines);
  const departure = leg.departure ?? leg.plannedDeparture ?? "";
  const arrival = leg.arrival ?? leg.plannedArrival ?? "";
  const actual = leg.departure ? Date.parse(leg.departure) : NaN;
  const planned = leg.plannedDeparture ? Date.parse(leg.plannedDeparture) : NaN;
  const delayMinutes = Number.isFinite(actual) && Number.isFinite(planned)
    ? Math.round((actual - planned) / 60_000)
    : null;
  return {
    id: `${style.lineId ?? "walk"}-${index}-${departure}`,
    walking,
    lineRef,
    lineId: style.lineId,
    mode,
    direction: walking ? null : leg.direction ?? null,
    originName: leg.origin?.name ?? "轨迹起点",
    destinationName: leg.destination?.name ?? "轨迹终点",
    departure,
    arrival,
    delayMinutes,
    polyline: polylinePoints(leg),
    color: walking ? "#78716C" : style.color,
    textColor: walking ? "#FFFFFF" : style.textColor,
  };
}

function parseJourney(
  journey: VbbJourney,
  index: number,
  drawn: LL[],
  lines: TransitLine[],
  viaStopName: string | null
): LiveJourneyCandidate | null {
  const legs = (journey.legs ?? [])
    .map((leg, legIndex) => parseLeg(leg, legIndex, lines))
    .filter((leg): leg is LiveJourneyLeg => Boolean(leg));
  const transitLegs = legs.filter((leg) => !leg.walking);
  if (!transitLegs.length) return null;
  const polyline: LL[] = [];
  for (const leg of legs) appendPoints(polyline, leg.polyline);
  if (polyline.length < 2) return null;
  const departure = legs[0]?.departure ?? "";
  const arrival = legs.at(-1)?.arrival ?? "";
  const duration = Date.parse(arrival) - Date.parse(departure);
  const geometry = scoreJourneyGeometry(drawn, polyline);
  return {
    id: `${transitLegs.map((leg) => leg.lineRef).join("-")}-${departure}-${index}`,
    legs,
    polyline,
    departure,
    arrival,
    durationMinutes: Number.isFinite(duration) ? Math.max(0, Math.round(duration / 60_000)) : 0,
    transfers: Math.max(0, transitLegs.length - 1),
    ...geometry,
    realtime: legs.some((leg) => leg.delayMinutes !== null),
    source: "live",
    viaStopName,
    checkpointCount: 0,
  };
}

function buildUrl(
  drawn: LL[],
  departure: string,
  modes: ModeFilter,
  viaStop: TransitStop | null
) {
  const [fromLat, fromLng] = drawn[0];
  const [toLat, toLng] = drawn[drawn.length - 1];
  const params = new URLSearchParams({
    "from.latitude": String(fromLat),
    "from.longitude": String(fromLng),
    "from.address": "手绘轨迹起点",
    "to.latitude": String(toLat),
    "to.longitude": String(toLng),
    "to.address": "手绘轨迹终点",
    departure: berlinLocalToIso(departure),
    results: "6",
    stopovers: "true",
    polylines: "true",
    remarks: "false",
    language: "de",
    suburban: String(modes.light_rail),
    subway: String(modes.subway),
    tram: String(modes.tram),
    bus: String(modes.bus),
    ferry: String(modes.ferry),
    regional: String(modes.rail),
    express: String(modes.rail),
  });
  if (viaStop) params.set("via", toApiStopId(viaStop.id));
  return `${API_URL}?${params}`;
}

function dedupeJourneys(journeys: LiveJourneyCandidate[]) {
  const unique = new Map<string, LiveJourneyCandidate>();
  for (const journey of journeys) {
    const signature = journey.legs
      .filter((leg) => !leg.walking)
      .map((leg) => `${leg.lineRef}:${leg.originName}:${leg.destinationName}:${leg.departure}`)
      .join("|");
    const existing = unique.get(signature);
    if (!existing || journey.similarity > existing.similarity) unique.set(signature, journey);
  }
  return [...unique.values()];
}

export async function fetchVbbJourneys({
  drawn,
  departure,
  modes,
  lines,
  signal,
  fetcher = fetch,
  allowVia = true,
}: {
  drawn: LL[];
  departure: string;
  modes: ModeFilter;
  lines: TransitLine[];
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  allowVia?: boolean;
}): Promise<LiveJourneyCandidate[]> {
  if (drawn.length < 2 || polylineLength(drawn) < 150) {
    throw new VbbNoMatchError("轨迹太短，请至少画出几个街区。");
  }
  if (!Object.values(modes).some(Boolean)) {
    throw new VbbNoMatchError("请至少打开一种交通方式。");
  }
  if (!departure || Number.isNaN(Date.parse(`${departure}:00Z`))) {
    throw new VbbNoMatchError("请选择有效的出发时间。");
  }

  const enabledLines = lines.filter((line) => modes[line.mode]);
  const viaStop = findViaStop(drawn, enabledLines);
  const requests: Array<{ url: string; via: TransitStop | null }> = [
    { url: buildUrl(drawn, departure, modes, null), via: null },
  ];
  if (allowVia && viaStop) {
    requests.push({ url: buildUrl(drawn, departure, modes, viaStop), via: viaStop });
  }

  const responses = await Promise.allSettled(
    requests.map(async ({ url, via }) => {
      const response = await fetcher(url, { signal });
      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          throw new VbbNoMatchError(`VBB 不支持这个日期或查询条件（HTTP ${response.status}）。`);
        }
        throw new VbbUnavailableError(`VBB 服务暂时不可用（HTTP ${response.status}）。`);
      }
      const payload = (await response.json()) as VbbResponse;
      return (payload.journeys ?? [])
        .map((journey, index) => parseJourney(journey, index, drawn, lines, via?.name ?? null))
        .filter((journey): journey is LiveJourneyCandidate => Boolean(journey));
    })
  );

  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  const candidates = dedupeJourneys(
    responses.flatMap((result) => (result.status === "fulfilled" ? result.value : []))
  )
    .filter(
      (candidate) =>
        candidate.similarity >= MIN_PLAUSIBLE_SIMILARITY &&
        candidate.coverage >= MIN_PLAUSIBLE_COVERAGE
    )
    .sort((a, b) => b.similarity - a.similarity || a.durationMinutes - b.durationMinutes);
  if (!candidates.length) {
    const failures = responses
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    const hadSuccessfulResponse = responses.some((result) => result.status === "fulfilled");
    if (hadSuccessfulResponse || failures.some((reason) => reason instanceof VbbNoMatchError)) {
      throw new VbbNoMatchError("没有找到与这段手绘轨迹足够贴合的真实 VBB 行程。");
    }
    throw new VbbUnavailableError("无法连接 VBB 行程服务。");
  }
  return candidates;
}

function combineJourneyParts(
  parts: LiveJourneyCandidate[],
  drawn: LL[],
  candidateIndex: number
): LiveJourneyCandidate {
  const legs = parts.flatMap((part, partIndex) =>
    part.legs.map((leg) => ({ ...leg, id: `${partIndex}-${leg.id}` }))
  );
  const polyline: LL[] = [];
  for (const part of parts) appendPoints(polyline, part.polyline);
  const transitLegs = legs.filter((leg) => !leg.walking);
  const departure = legs[0]?.departure ?? "";
  const arrival = legs.at(-1)?.arrival ?? "";
  const duration = Date.parse(arrival) - Date.parse(departure);
  return {
    id: `trace-${candidateIndex}-${departure}-${transitLegs.map((leg) => leg.lineRef).join("-")}`,
    legs,
    polyline,
    departure,
    arrival,
    durationMinutes: Number.isFinite(duration) ? Math.max(0, Math.round(duration / 60_000)) : 0,
    transfers: Math.max(0, transitLegs.length - 1),
    ...scoreJourneyGeometry(drawn, polyline),
    realtime: legs.some((leg) => leg.delayMinutes !== null),
    source: "live",
    viaStopName: null,
    checkpointCount: Math.max(0, parts.length - 1),
  };
}

/**
 * Resolve the whole drawing. Complex traces are queried in temporal order so
 * every next chunk departs only after the preceding VBB journey has arrived.
 */
export async function fetchVbbTraceJourneys(args: {
  drawn: LL[];
  departure: string;
  modes: ModeFilter;
  lines: TransitLine[];
  signal?: AbortSignal;
  fetcher?: typeof fetch;
}): Promise<LiveJourneyCandidate[]> {
  const segments = splitTrace(args.drawn);
  if (segments.length === 1) return fetchVbbJourneys(args);

  type Beam = {
    parts: LiveJourneyCandidate[];
    weightedSimilarity: number;
    weight: number;
  };
  let beams: Beam[] = [{ parts: [], weightedSimilarity: 0, weight: 0 }];

  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex++) {
    const segment = segments[segmentIndex];
    const segmentWeight = Math.max(1, polylineLength(segment));
    const attempts = await Promise.allSettled(
      beams.map(async (beam) => {
        const previousArrival = beam.parts.at(-1)?.arrival;
        const segmentDeparture = previousArrival
          ? formatDateTimeLocal(new Date(previousArrival))
          : args.departure;
        const candidates = await fetchVbbJourneys({
          ...args,
          drawn: segment,
          departure: segmentDeparture,
          allowVia: false,
        });
        return candidates.slice(0, 2).map((candidate) => ({
          parts: [...beam.parts, candidate],
          weightedSimilarity:
            beam.weightedSimilarity + candidate.similarity * segmentWeight,
          weight: beam.weight + segmentWeight,
        }));
      })
    );

    if (args.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const nextBeams = attempts
      .flatMap((attempt) => (attempt.status === "fulfilled" ? attempt.value : []))
      .sort(
        (a, b) =>
          b.weightedSimilarity / b.weight - a.weightedSimilarity / a.weight
      )
      .slice(0, 2);
    if (!nextBeams.length) {
      const failures = attempts
        .filter((attempt): attempt is PromiseRejectedResult => attempt.status === "rejected")
        .map((attempt) => attempt.reason);
      if (failures.some((reason) => reason instanceof VbbUnavailableError)) {
        throw new VbbUnavailableError("分段查询过程中 VBB 服务不可用。");
      }
      throw new VbbNoMatchError(
        `轨迹第 ${segmentIndex + 1}/${segments.length} 段没有足够贴合的真实公共交通行程。`
      );
    }
    beams = nextBeams;
  }

  const combined = dedupeJourneys(
    beams.map((beam, index) => combineJourneyParts(beam.parts, args.drawn, index))
  )
    .filter(
      (candidate) =>
        candidate.similarity >= MIN_PLAUSIBLE_SIMILARITY &&
        candidate.coverage >= MIN_PLAUSIBLE_COVERAGE
    )
    .sort((a, b) => b.similarity - a.similarity || a.durationMinutes - b.durationMinutes);
  if (!combined.length) {
    throw new VbbNoMatchError("分段行程可以乘坐，但组合后仍与整条手绘轨迹差异过大。");
  }
  return combined;
}
