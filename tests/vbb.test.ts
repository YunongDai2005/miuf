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

test("keeps VBB location endpoints and nested GeoJSON route geometry displayable", async () => {
  const fetcher: typeof fetch = async () =>
    Response.json({
      journeys: [
        {
          legs: [
            {
              walking: true,
              origin: {
                address: "Invalidenstraße 1",
                latitude: trace[0][0],
                longitude: trace[0][1] - 0.001,
              },
              destination: {
                name: "Berlin Hbf",
                location: { latitude: trace[0][0], longitude: trace[0][1] },
              },
              departure: "2026-07-21T15:58:00+02:00",
              arrival: "2026-07-21T16:00:00+02:00",
            },
            {
              origin: {
                name: "Berlin Hbf",
                location: { latitude: trace[0][0], longitude: trace[0][1] },
              },
              destination: {
                name: "Alexanderplatz",
                location: { latitude: trace.at(-1)![0], longitude: trace.at(-1)![1] },
              },
              departure: "2026-07-21T16:00:00+02:00",
              arrival: "2026-07-21T16:10:00+02:00",
              direction: "Pankow",
              line: { name: "U2", product: "subway" },
              polyline: {
                features: [
                  {
                    geometry: {
                      type: "LineString",
                      coordinates: trace.map(([lat, lng]) => [lng, lat]),
                    },
                  },
                ],
              },
            },
            {
              walking: true,
              origin: {
                name: "Alexanderplatz",
                location: { latitude: trace.at(-1)![0], longitude: trace.at(-1)![1] },
              },
              destination: {
                address: `${trace.at(-1)![0]}, ${trace.at(-1)![1] + 0.001}`,
                latitude: trace.at(-1)![0],
                longitude: trace.at(-1)![1] + 0.001,
              },
              departure: "2026-07-21T16:10:00+02:00",
              arrival: "2026-07-21T16:12:00+02:00",
            },
          ],
        },
      ],
    });

  const [result] = await fetchVbbJourneys({
    drawn: trace,
    departure: "2026-07-21T16:00",
    modes: allModes,
    lines: [u2],
    fetcher,
  });

  assert.equal(result.legs[0].originName, "Invalidenstraße 1");
  assert.deepEqual(result.legs[0].polyline, [
    [trace[0][0], trace[0][1] - 0.001],
    trace[0],
  ]);
  assert.deepEqual(result.legs[1].polyline, trace);
  assert.equal(result.legs[2].destinationName, "Photo route end");
  assert.deepEqual(result.legs[2].polyline, [
    trace.at(-1)!,
    [trace.at(-1)![0], trace.at(-1)![1] + 0.001],
  ]);
});

test("geometry score preserves path order instead of matching the same corridor backwards", () => {
  const forward = scoreJourneyGeometry(trace, trace);
  const backward = scoreJourneyGeometry(trace, [...trace].reverse());
  assert.ok(forward.similarity > 98);
  assert.ok(backward.similarity < forward.similarity - 15);
});

test("uses a wider but bounded matching corridor for a long hand-drawn loop", () => {
  const center: LL = [52.51, 13.4];
  const exact: LL[] = [];
  const rough: LL[] = [];
  for (let index = 0; index <= 24; index++) {
    const angle = Math.PI * 1.5 * (index / 24);
    exact.push([
      center[0] + Math.sin(angle) * 0.045,
      center[1] + Math.cos(angle) * 0.08,
    ]);
    rough.push([
      center[0] + Math.sin(angle) * 0.052,
      center[1] + Math.cos(angle) * 0.09,
    ]);
  }

  const longLoop = scoreJourneyGeometry(rough, exact);
  assert.ok(longLoop.similarity >= 30);
  assert.ok(longLoop.coverage >= 0.2);

  const shortOffset = scoreJourneyGeometry(
    [[52.5, 13.3], [52.5, 13.31]],
    [[52.51, 13.3], [52.51, 13.31]]
  );
  assert.ok(shortOffset.similarity < 30);

  const longStraight: LL[] = Array.from({ length: 41 }, (_, index) => [
    52.45 + (0.14 * index) / 40,
    13.3,
  ]);
  const wrongParallelRoute: LL[] = longStraight.map(([lat], index) => [
    lat,
    index === 0 || index === longStraight.length - 1 ? 13.3 : 13.32,
  ]);
  const parallel = scoreJourneyGeometry(longStraight, wrongParallelRoute);
  assert.ok(parallel.similarity < 30);
  assert.ok(parallel.coverage < 0.2);
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

test("keeps via-stop queries enabled for curved trace chunks", async () => {
  const loopTrace: LL[] = Array.from({ length: 41 }, (_, index) => {
    const angle = Math.PI * 1.5 * (index / 40);
    return [
      52.51 + Math.sin(angle) * 0.06,
      13.4 + Math.cos(angle) * 0.1,
    ];
  });
  const segments = splitTrace(loopTrace);
  assert.ok(segments.length > 1);

  const loopBox = bboxOf(loopTrace);
  const ringLine: TransitLine = {
    ...u2,
    id: "light_rail:S42",
    ref: "S42",
    mode: "light_rail",
    name: "Ringbahn S42",
    polylines: [loopTrace],
    polylineBboxes: [loopBox],
    bbox: loopBox,
    stops: loopTrace.map((point, index) => ({
      id: `de:11000:${900000000 + index}`,
      name: `Ring stop ${index}`,
      point,
    })),
  };

  const requestedViaStops: Array<string | null> = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const via = url.searchParams.get("via");
    requestedViaStops.push(via);
    if (!via) return Response.json({ journeys: [] });

    const from: LL = [
      Number(url.searchParams.get("from.latitude")),
      Number(url.searchParams.get("from.longitude")),
    ];
    const to: LL = [
      Number(url.searchParams.get("to.latitude")),
      Number(url.searchParams.get("to.longitude")),
    ];
    const segment = segments.find(
      (candidate) =>
        Math.abs(candidate[0][0] - from[0]) +
          Math.abs(candidate[0][1] - from[1]) +
          Math.abs(candidate.at(-1)![0] - to[0]) +
          Math.abs(candidate.at(-1)![1] - to[1]) <
        1e-8
    );
    assert.ok(segment);
    const departure = new Date(url.searchParams.get("departure")!);
    const arrival = new Date(departure.getTime() + 20 * 60_000);
    return Response.json({
      journeys: [
        {
          legs: [
            {
              origin: { name: "Chunk start", location: { latitude: from[0], longitude: from[1] } },
              destination: { name: "Chunk end", location: { latitude: to[0], longitude: to[1] } },
              departure: departure.toISOString(),
              plannedDeparture: departure.toISOString(),
              arrival: arrival.toISOString(),
              plannedArrival: arrival.toISOString(),
              direction: "Ring",
              line: { name: "S42", product: "suburban" },
              polyline: { features: segment.map(pointFeature) },
            },
          ],
        },
      ],
    });
  };

  const results = await fetchVbbTraceJourneys({
    drawn: loopTrace,
    departure: "2026-07-21T16:00",
    modes: allModes,
    lines: [ringLine],
    fetcher,
  });

  assert.ok(requestedViaStops.some(Boolean));
  assert.ok(requestedViaStops.every(Boolean));
  assert.equal(requestedViaStops.length, segments.length);
  assert.equal(results[0].checkpointCount, segments.length - 1);
  assert.equal(results[0].transfers, 0);
  assert.ok(results[0].similarity > 90);
});

test("converts canonical VBB stop ids for the journeys API", () => {
  assert.equal(toApiStopId("de:11000:900007110"), "900007110");
  assert.equal(toApiStopId("900007110"), "900007110");
});
