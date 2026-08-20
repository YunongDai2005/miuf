import type { LL } from "../berlin-transit/geo";
import type { JourneyMatch, TransitMode } from "../berlin-transit/transit";

/**
 * A read-only adapter over the existing offline `inferJourney` result. It does
 * NOT re-run or modify that algorithm — it only re-expresses a JourneyMatch as a
 * prioritized search plan for the UI. The chosen path normally becomes
 * high-priority; runner-up lines from the same corridor become medium/low. A
 * daytime photo can down-rank Berlin's N-prefixed night services. The 0–100
 * `routeMatch` is how tightly a line hugs the photo path, never a probability.
 * It orders candidates and sets the medium/low cutoff, but is deliberately not
 * surfaced in the UI: the priority badge says the same thing in words, and a
 * bare percentage reads as "we are 68% sure" — a precision this data lacks.
 */

export type SearchPriority = "high" | "medium" | "low";

export interface PrioritizedLine {
  lineId: string;
  ref: string;
  mode: TransitMode;
  color: string;
  textColor: string;
  priority: SearchPriority;
  routeMatch: number; // 0–100, higher = closer geometric match
  matchedLengthKm: number;
  matchedPolylines: LL[][];
  from?: string; // board stop (chosen segments only)
  to?: string; // alight stop (chosen segments only)
  timingNote?: string;
}

export interface OfflineRoutePlan {
  segments: PrioritizedLine[]; // the route selected by inferJourney
  alternatives: PrioritizedLine[]; // other corridor lines, medium/low priority
  confidence: number; // 0..1, carried through from the JourneyMatch
}

export interface OfflineRoutePlanOptions {
  /** EXIF epoch time or a Berlin-local datetime string used for coarse time plausibility. */
  referenceTime?: string | number | Date | null;
}

// DISPLAY_THRESHOLD_M in transit.ts — a line beyond this is off the corridor.
const MATCH_THRESHOLD_M = 245;
// Route-match at or above this reads as a medium (rather than low) alternative.
const MEDIUM_MATCH = 45;
const NIGHT_SERVICE_REF = /^N\d/i;

/** Combine how much of the path a line covers with how tightly it hugs it. */
function routeMatchScore(coverage: number, meanDistanceM: number): number {
  const tightness = Math.max(0, 1 - meanDistanceM / MATCH_THRESHOLD_M);
  return Math.round(100 * Math.min(1, Math.max(0, coverage)) * tightness);
}

function berlinHour(value: OfflineRoutePlanOptions["referenceTime"]): number | null {
  if (value == null || value === "") return null;

  // datetime-local values are already expressed in Berlin wall-clock time.
  if (typeof value === "string") {
    const localMatch = value.match(/^\d{4}-\d{2}-\d{2}T(\d{2}):\d{2}$/);
    if (localMatch) return Number(localMatch[1]);
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .find((part) => part.type === "hour")?.value;
  return hour == null ? null : Number(hour);
}

function applyTimingPriority(
  ref: string,
  priority: SearchPriority,
  referenceHour: number | null
): { priority: SearchPriority; timingNote?: string } {
  const nightWindow = referenceHour != null && (referenceHour < 5 || referenceHour >= 23);
  if (referenceHour == null || nightWindow || !NIGHT_SERVICE_REF.test(ref)) return { priority };
  return {
    priority: "low",
    timingNote: `Night service · unlikely around ${String(referenceHour).padStart(2, "0")}:00`,
  };
}

export function toOfflineRoutePlan(
  match: JourneyMatch,
  options: OfflineRoutePlanOptions = {}
): OfflineRoutePlan {
  const referenceHour = berlinHour(options.referenceTime);
  const segments: PrioritizedLine[] = match.segments.map((segment) => ({
    lineId: segment.line.id,
    ref: segment.line.ref,
    mode: segment.line.mode,
    color: segment.line.color,
    textColor: segment.line.textColor,
    ...applyTimingPriority(segment.line.ref, "high", referenceHour),
    routeMatch: routeMatchScore(segment.coverage, segment.meanDistanceM),
    matchedLengthKm: segment.matchedLengthKm,
    matchedPolylines: segment.matchedPolylines,
    from: segment.boardStop?.name,
    to: segment.alightStop?.name,
  }));

  const chosen = new Set(segments.map((segment) => segment.lineId));
  const alternatives: PrioritizedLine[] = match.alternatives
    .filter((alt) => !chosen.has(alt.line.id))
    .map((alt) => {
      const routeMatch = routeMatchScore(alt.coverage, alt.meanDistanceM);
      const basePriority: SearchPriority = routeMatch >= MEDIUM_MATCH ? "medium" : "low";
      return {
        lineId: alt.line.id,
        ref: alt.line.ref,
        mode: alt.line.mode,
        color: alt.line.color,
        textColor: alt.line.textColor,
        ...applyTimingPriority(alt.line.ref, basePriority, referenceHour),
        routeMatch,
        matchedLengthKm: alt.matchedLengthKm,
        matchedPolylines: alt.matchedPolylines,
      } satisfies PrioritizedLine;
    })
    .sort((a, b) => b.routeMatch - a.routeMatch);

  return { segments, alternatives, confidence: match.confidence };
}
