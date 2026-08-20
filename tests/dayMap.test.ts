import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDayMap,
  layoutLabels,
  pointAtLength,
  postcardSvgString,
  statLine,
} from "../app/lost-found/dayMap";
import type { PhotoAnchor } from "../app/lost-found/photos";
import type { SearchItem } from "../app/lost-found/data";

function venue(refId: string, label: string): SearchItem {
  return { kind: "venue", refId, label, sublabel: "", keywords: "" };
}

function anchor(
  i: number,
  lat: number,
  lng: number,
  time: number | null,
  v: SearchItem | null = null
): PhotoAnchor {
  return {
    id: `a${i}`,
    point: [lat, lng],
    time,
    venue: v,
    distanceM: v ? 10 : null,
    photoCount: 1,
  };
}

// A small Berlin day: Brandenburg Gate → Museum Island → Alexanderplatz.
const DAY: PhotoAnchor[] = [
  anchor(1, 52.5163, 13.3777, Date.UTC(2026, 6, 20, 8, 14), venue("bt", "Brandenburger Tor")),
  anchor(2, 52.5169, 13.4, Date.UTC(2026, 6, 20, 11, 30), venue("mi", "Museumsinsel")),
  anchor(3, 52.5219, 13.4132, Date.UTC(2026, 6, 20, 15, 32), null),
];

test("projects every stop inside the card bounds", () => {
  const model = buildDayMap(DAY);
  assert.equal(model.points.length, 3);
  for (const p of model.points) {
    assert.ok(p.x >= 0 && p.x <= model.width, `x in range: ${p.x}`);
    assert.ok(p.y >= 0 && p.y <= model.height, `y in range: ${p.y}`);
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
});

test("path + cumulative lengths track the stop order", () => {
  const model = buildDayMap(DAY);
  assert.equal((model.pathD.match(/L /g) ?? []).length, 2); // 3 stops → M + 2×L
  assert.equal(model.cumLengths.length, 3);
  assert.equal(model.cumLengths[0], 0);
  assert.ok(model.cumLengths[1] < model.cumLengths[2]); // strictly increasing
  assert.ok(Math.abs(model.cumLengths[2] - model.totalLength) < 1e-6);
});

test("north is up: an earlier, more-southern stop sits lower on the card", () => {
  const model = buildDayMap(DAY);
  // Alexanderplatz (52.5219) is the most northern → smallest y (nearer the top).
  assert.ok(model.points[2].y < model.points[0].y);
});

test("computes a plausible real-world distance and a Berlin time span", () => {
  const model = buildDayMap(DAY);
  // Gate→Island→Alex is roughly 2–4 km end to end.
  assert.ok(model.distanceKm > 1.5 && model.distanceKm < 5, `km=${model.distanceKm}`);
  assert.match(model.timeText, /^\d{2}:\d{2} – \d{2}:\d{2}$/);
  assert.equal(model.stopsText, "3 stops");
  assert.match(statLine(model), /3 stops {2}·/);
});

test("uses the passed day key for the date, and derives one otherwise", () => {
  assert.match(buildDayMap(DAY, { dayKey: "2026-07-20" }).dateText, /2026/);
  assert.match(buildDayMap(DAY).dateText, /2026/); // derived from photo times
  const untimed = [anchor(1, 52.5, 13.4, null), anchor(2, 52.51, 13.41, null)];
  assert.equal(buildDayMap(untimed).timeText, "");
  assert.equal(buildDayMap(untimed).dateText, "Your day in Berlin");
});

test("coincident anchors do not produce NaN", () => {
  const same = [anchor(1, 52.52, 13.405, 1), anchor(2, 52.52, 13.405, 2)];
  const model = buildDayMap(same);
  for (const p of model.points) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
  assert.equal(model.distanceKm, 0);
});

test("pointAtLength clamps to the route endpoints", () => {
  const model = buildDayMap(DAY);
  const start = pointAtLength(model, -100);
  const end = pointAtLength(model, model.totalLength + 100);
  assert.ok(Math.abs(start.x - model.points[0].x) < 1e-6);
  assert.ok(Math.abs(end.x - model.points[model.points.length - 1].x) < 1e-6);
});

test("labels stay within the card", () => {
  const model = buildDayMap(DAY);
  for (const label of layoutLabels(model)) {
    assert.ok(label.chipX >= 0 && label.chipX + label.chipW <= model.width);
    assert.ok(label.chipY >= 0 && label.chipY + label.chipH <= model.height);
  }
});

test("postcard SVG is self-contained and one marker per stop", () => {
  const model = buildDayMap(DAY, { dayKey: "2026-07-20" });
  const svg = postcardSvgString(model);
  assert.ok(svg.startsWith("<svg"));
  assert.ok(svg.includes('xmlns="http://www.w3.org/2000/svg"'));
  assert.doesNotMatch(svg, /NaN|undefined/);
  assert.doesNotMatch(svg, /foreignObject|<image/); // must rasterise cleanly
  assert.equal((svg.match(/stroke-width="3"/g) ?? []).length, 3); // 3 marker rings
  assert.ok(svg.includes("Museumsinsel"));
  assert.ok(svg.includes("Photo stop")); // the unmatched third stop
});

test("escapes XML-special characters in venue names", () => {
  const tricky = [
    anchor(1, 52.5, 13.4, 1, venue("a", "Fish & Chips <Berlin>")),
    anchor(2, 52.51, 13.41, 2, venue("b", "Museum")),
  ];
  const svg = postcardSvgString(buildDayMap(tricky));
  assert.ok(svg.includes("Fish &amp; Chips &lt;Berlin&gt;"));
  assert.ok(!svg.includes("Fish & Chips <Berlin>"));
});
