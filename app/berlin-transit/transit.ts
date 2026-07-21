import {
  type LL,
  type BBox,
  bboxIntersect,
  bboxOf,
  dist,
  pointInBbox,
  pointToPolyline,
  polylineLength,
  resample,
} from "./geo";

export type TransitMode =
  | "subway"
  | "light_rail"
  | "tram"
  | "bus"
  | "rail"
  | "ferry";

export interface TransitStop {
  id: string;
  name: string;
  point: LL;
}

export interface TransitLine {
  id: string;
  mode: TransitMode;
  ref: string;
  name: string;
  color: string;
  textColor: string;
  polylines: LL[][];
  polylineBboxes: BBox[];
  bbox: BBox;
  stops: TransitStop[];
}

export interface TransitNetwork {
  source: string;
  sourceUrl: string;
  sourceUpdatedAt: string;
  license: string;
  lines: TransitLine[];
}

export interface MatchResult {
  line: TransitLine;
  coverage: number;
  meanDistanceM: number;
  matchedLengthKm: number;
  matchedPolylines: LL[][];
}

export interface JourneySegment extends MatchResult {
  start: LL;
  end: LL;
  boardStop: TransitStop | null;
  alightStop: TransitStop | null;
}

export interface JourneyMatch {
  segments: JourneySegment[];
  alternatives: MatchResult[];
  coverage: number;
  confidence: number;
  totalLengthKm: number;
  unexplainedLengthKm: number;
}

const SAMPLE_SPACING_M = 65;
const MATCH_THRESHOLD_M = 230;
const DISPLAY_THRESHOLD_M = 245;
const MAX_POINT_CANDIDATES = 9;
const MAX_ALTERNATIVES = 4;
const SWITCH_PENALTY = 2.8;
const WALK_SWITCH_PENALTY = 0.55;
const WALK_EMISSION_COST = 1.12;
const MIN_SEGMENT_SAMPLES = 3;

const MODE_LABEL: Record<TransitMode, string> = {
  subway: "U-Bahn",
  light_rail: "S-Bahn",
  tram: "Tram",
  bus: "Bus",
  rail: "区域列车",
  ferry: "渡轮",
};

export function modeLabel(mode: TransitMode): string {
  return MODE_LABEL[mode] ?? mode;
}

function distanceToLine(point: LL, line: TransitLine): number {
  if (!pointInBbox(point, line.bbox, MATCH_THRESHOLD_M)) return Infinity;
  let nearest = Infinity;
  for (let index = 0; index < line.polylines.length; index++) {
    const polyline = line.polylines[index];
    const box = line.polylineBboxes[index] ?? bboxOf(polyline);
    if (!pointInBbox(point, box, MATCH_THRESHOLD_M)) continue;
    nearest = Math.min(nearest, pointToPolyline(point, polyline));
  }
  return nearest;
}

function nearestStop(point: LL, stops: TransitStop[]): TransitStop | null {
  let nearest: TransitStop | null = null;
  let nearestDistance = 500;
  for (const stop of stops) {
    const distance = dist(point, stop.point);
    if (distance < nearestDistance) {
      nearest = stop;
      nearestDistance = distance;
    }
  }
  return nearest;
}

/** Clip and densify line geometry so the displayed overlap follows segments, not sparse vertices. */
function clipLineToPath(
  line: TransitLine,
  path: LL[],
  threshold = DISPLAY_THRESHOLD_M
): LL[][] {
  const output: LL[][] = [];
  const pathBox = bboxOf(path, threshold);

  for (let index = 0; index < line.polylines.length; index++) {
    const polyline = line.polylines[index];
    const lineBox = line.polylineBboxes[index] ?? bboxOf(polyline);
    if (!bboxIntersect(pathBox, lineBox)) continue;
    const dense = resample(polyline, 35);
    let run: LL[] = [];

    for (let pointIndex = 0; pointIndex < dense.length; pointIndex++) {
      const point = dense[pointIndex];
      const close = pointToPolyline(point, path) <= threshold;
      if (close) {
        if (!run.length && pointIndex > 0) run.push(dense[pointIndex - 1]);
        run.push(point);
      } else if (run.length) {
        run.push(point);
        if (run.length >= 2) output.push(run);
        run = [];
      }
    }
    if (run.length >= 2) output.push(run);
  }
  return output;
}

type PointCandidate = { lineIndex: number | null; distance: number };

function transitionCost(previous: number | null, current: number | null): number {
  if (previous === current) return 0;
  if (previous === null || current === null) return WALK_SWITCH_PENALTY;
  return SWITCH_PENALTY;
}

function emissionCost(candidate: PointCandidate): number {
  if (candidate.lineIndex === null) return WALK_EMISSION_COST;
  return Math.pow(candidate.distance / 150, 1.35);
}

function compressAssignments(assignments: Array<number | null>) {
  const runs: Array<{ state: number | null; start: number; end: number }> = [];
  assignments.forEach((state, index) => {
    const previous = runs[runs.length - 1];
    if (previous?.state === state) previous.end = index;
    else runs.push({ state, start: index, end: index });
  });
  return runs;
}

function smoothAssignments(assignments: Array<number | null>) {
  const smoothed = [...assignments];
  for (let pass = 0; pass < 2; pass++) {
    const runs = compressAssignments(smoothed);
    for (let index = 0; index < runs.length; index++) {
      const run = runs[index];
      const sampleCount = run.end - run.start + 1;
      const previous = runs[index - 1]?.state;
      const next = runs[index + 1]?.state;
      if (sampleCount >= MIN_SEGMENT_SAMPLES) continue;
      const replacement = previous === next ? previous : null;
      for (let sample = run.start; sample <= run.end; sample++) {
        smoothed[sample] = replacement ?? null;
      }
    }
  }
  return smoothed;
}

/** Infer a continuous, ordered transit journey from a hand-drawn path. */
export function inferJourney(drawn: LL[], lines: TransitLine[]): JourneyMatch | null {
  const sampled = resample(drawn, SAMPLE_SPACING_M);
  if (sampled.length < 2 || polylineLength(sampled) < 120) return null;

  const pointCandidates: PointCandidate[][] = sampled.map((point) => {
    const nearby = lines
      .map((line, lineIndex) => ({ lineIndex, distance: distanceToLine(point, line) }))
      .filter((candidate) => candidate.distance <= MATCH_THRESHOLD_M)
      .sort((a, b) => a.distance - b.distance)
      .slice(0, MAX_POINT_CANDIDATES);
    return [...nearby, { lineIndex: null, distance: Infinity }];
  });

  const costs: number[][] = [];
  const previousStates: number[][] = [];
  costs[0] = pointCandidates[0].map(emissionCost);
  previousStates[0] = pointCandidates[0].map(() => -1);

  for (let sampleIndex = 1; sampleIndex < sampled.length; sampleIndex++) {
    const currentCandidates = pointCandidates[sampleIndex];
    const previousCandidates = pointCandidates[sampleIndex - 1];
    costs[sampleIndex] = [];
    previousStates[sampleIndex] = [];
    for (let currentIndex = 0; currentIndex < currentCandidates.length; currentIndex++) {
      let bestCost = Infinity;
      let bestPrevious = -1;
      for (let previousIndex = 0; previousIndex < previousCandidates.length; previousIndex++) {
        const cost =
          costs[sampleIndex - 1][previousIndex] +
          transitionCost(
            previousCandidates[previousIndex].lineIndex,
            currentCandidates[currentIndex].lineIndex
          );
        if (cost < bestCost) {
          bestCost = cost;
          bestPrevious = previousIndex;
        }
      }
      costs[sampleIndex][currentIndex] = bestCost + emissionCost(currentCandidates[currentIndex]);
      previousStates[sampleIndex][currentIndex] = bestPrevious;
    }
  }

  const finalCosts = costs[costs.length - 1];
  let stateIndex = finalCosts.indexOf(Math.min(...finalCosts));
  const assignments: Array<number | null> = Array(sampled.length).fill(null);
  for (let sampleIndex = sampled.length - 1; sampleIndex >= 0; sampleIndex--) {
    assignments[sampleIndex] = pointCandidates[sampleIndex][stateIndex].lineIndex;
    stateIndex = previousStates[sampleIndex][stateIndex];
  }
  const smoothed = smoothAssignments(assignments);
  const runs = compressAssignments(smoothed).filter((run) => run.state !== null);

  const segments: JourneySegment[] = runs.map((run) => {
    const line = lines[run.state as number];
    const segmentPath = sampled.slice(Math.max(0, run.start - 1), Math.min(sampled.length, run.end + 2));
    const distances = sampled
      .slice(run.start, run.end + 1)
      .map((point) => distanceToLine(point, line));
    const segmentLengthKm = polylineLength(segmentPath) / 1000;
    return {
      line,
      start: sampled[run.start],
      end: sampled[run.end],
      boardStop: nearestStop(sampled[run.start], line.stops),
      alightStop: nearestStop(sampled[run.end], line.stops),
      coverage: 1,
      meanDistanceM: distances.reduce((sum, value) => sum + value, 0) / distances.length,
      matchedLengthKm: segmentLengthKm,
      matchedPolylines: clipLineToPath(line, segmentPath),
    };
  });

  if (!segments.length) return null;

  const matchedSamples = smoothed.filter((state) => state !== null).length;
  const coverage = matchedSamples / smoothed.length;
  const totalLengthKm = polylineLength(sampled) / 1000;
  const meanDistanceM =
    segments.reduce(
      (sum, segment) => sum + segment.meanDistanceM * Math.max(segment.matchedLengthKm, 0.05),
      0
    ) / segments.reduce((sum, segment) => sum + Math.max(segment.matchedLengthKm, 0.05), 0);
  const confidence = Math.max(
    0,
    Math.min(
      0.99,
      (coverage * 0.72 + Math.max(0, 1 - meanDistanceM / MATCH_THRESHOLD_M) * 0.28) *
        Math.max(0.72, 1 - (segments.length - 1) * 0.045)
    )
  );

  const usedLines = new Set(segments.map((segment) => segment.line.id));
  const alternativeStats = new Map<number, { count: number; distance: number }>();
  pointCandidates.forEach((candidates) => {
    candidates.forEach((candidate) => {
      if (candidate.lineIndex === null) return;
      const stat = alternativeStats.get(candidate.lineIndex) ?? { count: 0, distance: 0 };
      stat.count++;
      stat.distance += candidate.distance;
      alternativeStats.set(candidate.lineIndex, stat);
    });
  });

  const alternatives = [...alternativeStats.entries()]
    .filter(([lineIndex, stat]) => !usedLines.has(lines[lineIndex].id) && stat.count / sampled.length >= 0.25)
    .map(([lineIndex, stat]) => {
      const line = lines[lineIndex];
      const alternativeCoverage = stat.count / sampled.length;
      return {
        line,
        coverage: alternativeCoverage,
        meanDistanceM: stat.distance / stat.count,
        matchedLengthKm: totalLengthKm * alternativeCoverage,
        matchedPolylines: clipLineToPath(line, sampled),
      };
    })
    .sort((a, b) => b.coverage - a.coverage || a.meanDistanceM - b.meanDistanceM)
    .slice(0, MAX_ALTERNATIVES);

  return {
    segments,
    alternatives,
    coverage,
    confidence,
    totalLengthKm,
    unexplainedLengthKm: totalLengthKm * (1 - coverage),
  };
}
