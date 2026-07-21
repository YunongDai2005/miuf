import assert from "node:assert/strict";
import test from "node:test";
import { bboxOf, type LL } from "../app/berlin-transit/geo";
import type { TransitLine } from "../app/berlin-transit/transit";
import {
  berlinLocalToIso,
  fetchVbbJourneys,
  fetchVbbTraceJourneys,
  scoreJourneyGeometry,
  splitTrace,
  toApiStopId,
  type ModeFilter,
  VbbNoMatchError,
} from "../app/berlin-transit/vbb";

const allModes: ModeFilter = {
  subway: true,
  light_rail: true,
  tram: true,
  bus: true,
  rail: true,
  ferry: true,
};

const trace: LL[] = [
  [52.5201, 13.3693],
  [52.5215, 13.39],
  [52.5219, 13.4132],
];

const u2: TransitLine = {
  id: "subway:U2",
  ref: "U2",
  mode: "subway",
  name: "U2",
  color: "#DA421E",
  textColor: "#FFFFFF",
  polylines: [trace],
  polylineBboxes: [bboxOf(trace)],
  bbox: bboxOf(trace),
  stops: [
    { id: "de:11000:900003201", name: "Berlin Hbf", point: trace[0] },
    { id: "de:11000:900100003", name: "Alexanderplatz", point: trace.at(-1)! },
  ],
};

function pointFeature([lat, lng]: LL) {
  return { geometry: { coordinates: [lng, lat] } };
}

function journey(points: LL[], line = "U2") {
  return {
    legs: [
      {
        walking: true,
        origin: { name: "手绘轨迹起点", location: { latitude: points[0][0], longitude: points[0][1] } },
        destination: { name: "Berlin Hbf", location: { latitude: points[0][0], longitude: points[0][1] } },
        departure: "2026-07-21T15:58:00+02:00",
        arrival: "2026-07-21T16:00:00+02:00",
      },
      {
        origin: { name: "Berlin Hbf", location: { latitude: points[0][0], longitude: points[0][1] } },
        destination: {
          name: "Alexanderplatz",
          location: { latitude: points.at(-1)![0], longitude: points.at(-1)![1] },
        },
        departure: "2026-07-21T16:00:00+02:00",
        plannedDeparture: "2026-07-21T15:58:00+02:00",
        arrival: "2026-07-21T16:10:00+02:00",
        plannedArrival: "2026-07-21T16:08:00+02:00",
        direction: "Pankow",
        line: { name: line, product: "subway" },
        polyline: { features: points.map(pointFeature) },
      },
      {
        walking: true,
        origin: {
          name: "Alexanderplatz",
          location: { latitude: points.at(-1)![0], longitude: points.at(-1)![1] },
        },
        destination: {
          name: "手绘轨迹终点",
          location: { latitude: points.at(-1)![0], longitude: points.at(-1)![1] },
        },
        departure: "2026-07-21T16:10:00+02:00",
        arrival: "2026-07-21T16:12:00+02:00",
      },
    ],
  };
}

test("interprets datetime-local values in Berlin, including daylight saving", () => {
  assert.equal(berlinLocalToIso("2026-07-21T16:00"), "2026-07-21T14:00:00.000Z");
  assert.equal(berlinLocalToIso("2026-01-21T16:00"), "2026-01-21T15:00:00.000Z");
});

test("parses real VBB journey semantics and ranks the closest scheduled geometry first", async () => {
  const detour: LL[] = [trace[0], [52.527, 13.39], trace.at(-1)!];
  let requestedUrl = "";
  const fetcher: typeof fetch = async (input) => {
    requestedUrl = String(input);
    return Response.json({ journeys: [journey(detour, "U8"), journey(trace)] });
  };

  const results = await fetchVbbJourneys({
    drawn: trace,
    departure: "2026-07-21T16:00",
    modes: allModes,
    lines: [u2],
    fetcher,
  });

  assert.equal(results.length, 2);
  assert.equal(results[0].legs[1].lineRef, "U2");
  assert.equal(results[0].legs[1].direction, "Pankow");
  assert.equal(results[0].legs[1].delayMinutes, 2);
  assert.equal(results[0].legs[1].color, "#DA421E");
  assert.equal(results[0].durationMinutes, 14);
  assert.equal(results[0].transfers, 0);
  assert.ok(results[0].similarity > results[1].similarity);

  const url = new URL(requestedUrl);
  assert.equal(url.searchParams.get("polylines"), "true");
  assert.equal(url.searchParams.get("stopovers"), "true");
  assert.equal(url.searchParams.get("departure"), "2026-07-21T14:00:00.000Z");
  assert.equal(url.searchParams.get("subway"), "true");
});

test("geometry score preserves path order instead of matching the same corridor backwards", () => {
  const forward = scoreJourneyGeometry(trace, trace);
  const backward = scoreJourneyGeometry(trace, [...trace].reverse());
  assert.ok(forward.similarity > 98);
  assert.ok(backward.similarity < forward.similarity - 15);
});

test("rejects a timetable-valid journey when its geometry does not match the drawing", async () => {
  const unrelated: LL[] = [
    [52.64, 13.68],
    [52.66, 13.72],
  ];
  const fetcher: typeof fetch = async () => Response.json({ journeys: [journey(unrelated)] });
  await assert.rejects(
    fetchVbbJourneys({
      drawn: trace,
      departure: "2026-07-21T16:00",
      modes: allModes,
      lines: [u2],
      fetcher,
    }),
    VbbNoMatchError
  );
});

test("splits a long multi-turn trace and queries every chunk in chronological order", async () => {
  const complexTrace: LL[] = [
    [52.47, 13.2],
    [52.62, 13.22],
    [52.61, 13.55],
    [52.44, 13.54],
    [52.43, 13.3],
  ];
  assert.ok(splitTrace(complexTrace).length > 1);

  const requestedDepartures: number[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const from: LL = [
      Number(url.searchParams.get("from.latitude")),
      Number(url.searchParams.get("from.longitude")),
    ];
    const to: LL = [
      Number(url.searchParams.get("to.latitude")),
      Number(url.searchParams.get("to.longitude")),
    ];
    const departure = new Date(url.searchParams.get("departure")!);
    const arrival = new Date(departure.getTime() + 30 * 60_000);
    requestedDepartures.push(departure.getTime());
    return Response.json({
      journeys: [
        {
          legs: [
            {
              origin: { name: "检查点", location: { latitude: from[0], longitude: from[1] } },
              destination: { name: "下一检查点", location: { latitude: to[0], longitude: to[1] } },
              departure: departure.toISOString(),
              plannedDeparture: departure.toISOString(),
              arrival: arrival.toISOString(),
              plannedArrival: arrival.toISOString(),
              direction: "沿轨迹前进",
              line: { name: "X1", product: "bus" },
              polyline: { features: [pointFeature(from), pointFeature(to)] },
            },
          ],
        },
      ],
    });
  };

  const results = await fetchVbbTraceJourneys({
    drawn: complexTrace,
    departure: "2026-07-21T16:00",
    modes: allModes,
    lines: [u2],
    fetcher,
  });

  assert.ok(requestedDepartures.length > 1);
  assert.ok(requestedDepartures.every((value, index) => index === 0 || value >= requestedDepartures[index - 1]));
  assert.equal(results[0].checkpointCount, requestedDepartures.length - 1);
  assert.ok(results[0].similarity >= 30);
});

test("converts canonical VBB stop ids for the journeys API", () => {
  assert.equal(toApiStopId("de:11000:900007110"), "900007110");
  assert.equal(toApiStopId("900007110"), "900007110");
});
