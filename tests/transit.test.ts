import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { bboxOf, resample, type LL } from "../app/berlin-transit/geo";
import {
  inferJourney,
  type TransitLine,
  type TransitNetwork,
} from "../app/berlin-transit/transit";

function makeLine(id: string, ref: string, polyline: LL[]): TransitLine {
  const color = id === "a" ? "#0067B1" : "#D71920";
  return {
    id,
    ref,
    mode: id === "a" ? "subway" : "tram",
    name: ref,
    color,
    textColor: "#FFFFFF",
    polylines: [polyline],
    polylineBboxes: [bboxOf(polyline)],
    bbox: bboxOf(polyline),
    stops: [
      { id: `${id}-start`, name: `${ref} 起点`, point: polyline[0] },
      { id: `${id}-end`, name: `${ref} 终点`, point: polyline[polyline.length - 1] },
    ],
  };
}

test("resample keeps the exact final point", () => {
  const path: LL[] = [[52.5, 13.3], [52.5, 13.30123]];
  const sampled = resample(path, 40);
  assert.deepEqual(sampled.at(-1), path.at(-1));
});

test("infers ordered segments and a transfer", () => {
  const first: LL[] = [[52.5, 13.3], [52.5, 13.36], [52.5, 13.42]];
  const second: LL[] = [[52.5, 13.42], [52.54, 13.42], [52.58, 13.42]];
  const drawing: LL[] = [...first, ...second.slice(1)];
  const match = inferJourney(drawing, [makeLine("a", "U-Test", first), makeLine("b", "M-Test", second)]);
  assert.ok(match);
  assert.deepEqual(match.segments.map((segment) => segment.line.ref), ["U-Test", "M-Test"]);
  assert.ok(match.coverage > 0.9);
  assert.ok(match.confidence > 0.7);
  assert.equal(match.segments[0].boardStop?.name, "U-Test 起点");
  assert.equal(match.segments[1].alightStop?.name, "M-Test 终点");
});

test("matches a real U2 trace without fragmenting it", async () => {
  const raw = await readFile(new URL("../public/berlin-transit.json", import.meta.url), "utf8");
  const network = JSON.parse(raw) as TransitNetwork;
  const u2 = network.lines.find((line) => line.ref === "U2" && line.mode === "subway");
  assert.ok(u2);
  const trace = [...u2.polylines].sort((a, b) => b.length - a.length)[0];
  const match = inferJourney(trace, network.lines.filter((line) => line.mode === "subway"));
  assert.ok(match);
  assert.equal(match.segments[0].line.ref, "U2");
  assert.ok(match.coverage > 0.75);
});
