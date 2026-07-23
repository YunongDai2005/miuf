import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { JourneyMatch, JourneySegment, MatchResult, TransitLine } from "../app/berlin-transit/transit";
import JourneyInference from "../app/lost-found/JourneyInference";
import { toOfflineRoutePlan } from "../app/lost-found/offlineRoute";
import type { PhotoAnchor } from "../app/lost-found/photos";

function line(id: string, ref: string): TransitLine {
  return { id, ref, mode: "subway", color: "#f90", textColor: "#fff", name: ref } as unknown as TransitLine;
}

function segment(id: string, ref: string, coverage: number, meanDistanceM: number): JourneySegment {
  return {
    line: line(id, ref),
    coverage,
    meanDistanceM,
    matchedLengthKm: 2,
    matchedPolylines: [[[52.5, 13.4], [52.5, 13.42]]],
    boardStop: { id: `${id}-b`, name: "Board", point: [52.5, 13.4] },
    alightStop: { id: `${id}-a`, name: "Alight", point: [52.5, 13.42] },
    start: [52.5, 13.4],
    end: [52.5, 13.42],
  } as unknown as JourneySegment;
}

function alternative(id: string, ref: string, coverage: number, meanDistanceM: number): MatchResult {
  return {
    line: line(id, ref),
    coverage,
    meanDistanceM,
    matchedLengthKm: 1,
    matchedPolylines: [[[52.5005, 13.4], [52.5005, 13.42]]],
  } as MatchResult;
}

const MATCH: JourneyMatch = {
  segments: [segment("u5", "U5", 1, 40)],
  alternatives: [
    alternative("u8", "U8", 0.7, 60), // strong runner-up → medium
    alternative("m10", "M10", 0.3, 200), // weak → low
    alternative("u5", "U5", 0.9, 30), // duplicates the chosen line → dropped
  ],
  coverage: 0.9,
  confidence: 0.66,
  totalLengthKm: 4,
  unexplainedLengthKm: 0.4,
} as unknown as JourneyMatch;

const NIGHT_MATCH: JourneyMatch = {
  ...MATCH,
  alternatives: [alternative("n2", "N2", 0.8, 40)],
} as unknown as JourneyMatch;

test("marks the chosen route as high priority with board/alight and a route match", () => {
  const plan = toOfflineRoutePlan(MATCH);
  assert.equal(plan.segments.length, 1);
  const [seg] = plan.segments;
  assert.equal(seg.ref, "U5");
  assert.equal(seg.priority, "high");
  assert.equal(seg.from, "Board");
  assert.equal(seg.to, "Alight");
  assert.ok(seg.routeMatch > 80, `route match was ${seg.routeMatch}`);
  assert.equal(plan.confidence, 0.66);
});

test("maps alternatives to medium/low by coverage and mean distance, dropping the chosen line", () => {
  const plan = toOfflineRoutePlan(MATCH);
  assert.deepEqual(
    plan.alternatives.map((a) => [a.ref, a.priority]),
    [
      ["U8", "medium"],
      ["M10", "low"],
    ]
  );
  // sorted by route match descending
  assert.ok(plan.alternatives[0].routeMatch > plan.alternatives[1].routeMatch);
  // never called a probability — it's a 0..100 route-match figure
  assert.ok(plan.alternatives[0].routeMatch >= 0 && plan.alternatives[0].routeMatch <= 100);
});

test("down-ranks night services for daytime photos", () => {
  const plan = toOfflineRoutePlan(NIGHT_MATCH, { referenceTime: "2026-07-23T14:00" });
  assert.equal(plan.alternatives[0].ref, "N2");
  assert.equal(plan.alternatives[0].priority, "low");
  assert.match(plan.alternatives[0].timingNote ?? "", /Night service/);
});

test("keeps a geometrically strong night service at medium priority during the night window", () => {
  const plan = toOfflineRoutePlan(NIGHT_MATCH, { referenceTime: "2026-07-23T01:00" });
  assert.equal(plan.alternatives[0].ref, "N2");
  assert.equal(plan.alternatives[0].priority, "medium");
  assert.equal(plan.alternatives[0].timingNote, undefined);
});

test("renders primary and alternative offline geometry as a search corridor", () => {
  const anchors: PhotoAnchor[] = [
    {
      id: "photo-1",
      point: [52.5, 13.4],
      time: Date.parse("2026-07-22T23:00:00Z"),
      venue: null,
      distanceM: null,
      photoCount: 1,
    },
    {
      id: "photo-2",
      point: [52.5, 13.42],
      time: Date.parse("2026-07-22T23:10:00Z"),
      venue: null,
      distanceM: null,
      photoCount: 1,
    },
  ];
  const html = renderToStaticMarkup(
    createElement(JourneyInference, {
      anchors,
      busy: false,
      candidates: [],
      selectedIndex: 0,
      offlinePlan: toOfflineRoutePlan(NIGHT_MATCH, { referenceTime: "2026-07-23T01:00" }),
      notice: null,
      used: false,
      onSelect: () => {},
      onUse: () => {},
    })
  );

  assert.match(html, /Search corridor showing the primary inferred route/);
  assert.match(html, /Search corridor · solid primary · faded alternatives/);
  assert.match(html, /Other lines in the corridor/);
  assert.match(html, /stroke-opacity="0\.95"/);
  assert.match(html, /stroke-opacity="0\.48"/);
});
