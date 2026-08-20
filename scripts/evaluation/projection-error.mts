/**
 * Quantifies the error introduced by the local equirectangular projection in
 * app/berlin-transit/geo.ts, which trades exactness for speed by fixing the
 * longitude scale at a single reference latitude (52.52 N).
 *
 * The thesis states that this approximation is negligible at Berlin's scale.
 * This script measures whether that is true, and — the question that actually
 * matters — whether the error is ever large enough to move a point across one
 * of the fixed distance thresholds the matching pipeline depends on.
 *
 * Reference distances use the Vincenty inverse/direct solutions on WGS-84,
 * which agree with rigorous geodesics to well under a millimetre at these
 * ranges, so the residual is entirely attributable to the projection.
 *
 *   node --import tsx scripts/evaluation/projection-error.mts
 */
import { readFileSync } from "node:fs";
import { dist, type LL } from "../../app/berlin-transit/geo";

// ---------------------------------------------------------------- WGS-84
const A = 6378137.0;
const F = 1 / 298.257223563;
const B = A * (1 - F);
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Vincenty inverse — kept as the independent check on the direct solution. */
export function vincenty(p1: LL, p2: LL): number {
  const L = rad(p2[1] - p1[1]);
  const U1 = Math.atan((1 - F) * Math.tan(rad(p1[0])));
  const U2 = Math.atan((1 - F) * Math.tan(rad(p2[0])));
  const sU1 = Math.sin(U1), cU1 = Math.cos(U1);
  const sU2 = Math.sin(U2), cU2 = Math.cos(U2);
  let lambda = L, prev = 0, iter = 0;
  let sSig = 0, cSig = 0, sigma = 0, cSqAl = 0, c2SigM = 0;
  do {
    const sL = Math.sin(lambda), cL = Math.cos(lambda);
    sSig = Math.sqrt((cU2 * sL) ** 2 + (cU1 * sU2 - sU1 * cU2 * cL) ** 2);
    if (sSig === 0) return 0;
    cSig = sU1 * sU2 + cU1 * cU2 * cL;
    sigma = Math.atan2(sSig, cSig);
    const sAl = (cU1 * cU2 * sL) / sSig;
    cSqAl = 1 - sAl * sAl;
    c2SigM = cSqAl === 0 ? 0 : cSig - (2 * sU1 * sU2) / cSqAl;
    const C = (F / 16) * cSqAl * (4 + F * (4 - 3 * cSqAl));
    prev = lambda;
    lambda =
      L +
      (1 - C) * F * sAl *
        (sigma + C * sSig * (c2SigM + C * cSig * (-1 + 2 * c2SigM ** 2)));
  } while (Math.abs(lambda - prev) > 1e-12 && ++iter < 200);

  const uSq = cSqAl * (A * A - B * B) / (B * B);
  const Ac = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const Bc = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const dSig =
    Bc * sSig *
    (c2SigM +
      (Bc / 4) *
        (cSig * (-1 + 2 * c2SigM ** 2) -
          (Bc / 6) * c2SigM * (-3 + 4 * sSig ** 2) * (-3 + 4 * c2SigM ** 2)));
  return B * Ac * (sigma - dSig);
}

/** Vincenty direct — the point exactly `s` metres from `p` on bearing `alpha1`. */
function vincentyDirect(p: LL, alpha1: number, s: number): LL {
  const sA1 = Math.sin(alpha1), cA1 = Math.cos(alpha1);
  const U1 = Math.atan((1 - F) * Math.tan(rad(p[0])));
  const sU1 = Math.sin(U1), cU1 = Math.cos(U1);
  const sigma1 = Math.atan2(Math.tan(U1), cA1);
  const sAl = cU1 * sA1;
  const cSqAl = 1 - sAl * sAl;
  const uSq = (cSqAl * (A * A - B * B)) / (B * B);
  const Ac = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const Bc = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  let sigma = s / (B * Ac), prev = 0, iter = 0, c2SigM = 0;
  do {
    c2SigM = Math.cos(2 * sigma1 + sigma);
    const sSig = Math.sin(sigma), cSig = Math.cos(sigma);
    const dSig =
      Bc * sSig *
      (c2SigM +
        (Bc / 4) *
          (cSig * (-1 + 2 * c2SigM ** 2) -
            (Bc / 6) * c2SigM * (-3 + 4 * sSig ** 2) * (-3 + 4 * c2SigM ** 2)));
    prev = sigma;
    sigma = s / (B * Ac) + dSig;
  } while (Math.abs(sigma - prev) > 1e-12 && ++iter < 200);

  const sSig = Math.sin(sigma), cSig = Math.cos(sigma);
  const tmp = sU1 * sSig - cU1 * cSig * cA1;
  const lat2 = Math.atan2(
    sU1 * cSig + cU1 * sSig * cA1,
    (1 - F) * Math.sqrt(sAl * sAl + tmp * tmp)
  );
  const lambda = Math.atan2(sSig * sA1, cU1 * cSig - sU1 * sSig * cA1);
  const C = (F / 16) * cSqAl * (4 + F * (4 - 3 * cSqAl));
  const L =
    lambda -
    (1 - C) * F * sAl *
      (sigma + C * sSig * (c2SigM + C * cSig * (-1 + 2 * c2SigM ** 2)));
  return [deg(lat2), p[1] + deg(L)];
}

/** Spherical haversine, the usual textbook reference. */
function haversine(p1: LL, p2: LL): number {
  const R = 6371008.8;
  const dLat = rad(p2[0] - p1[0]);
  const dLon = rad(p2[1] - p1[1]);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(p1[0])) * Math.cos(rad(p2[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ------------------------------------------------- deterministic sampling
/** mulberry32 — a fixed seed keeps the reported figures reproducible. */
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Every coordinate the shipped app can actually encounter. */
function operatingPoints(): LL[] {
  const pts: LL[] = [];
  const push = (lat: number, lng: number) => {
    if (lat > 50 && lat < 55 && lng > 11 && lng < 15) pts.push([lat, lng]);
  };
  const att = JSON.parse(readFileSync("public/berlin-attractions.json", "utf8"));
  for (const v of att.attractions ?? att) {
    if (Array.isArray(v.point)) push(v.point[0], v.point[1]);
  }
  const walk = (o: unknown): void => {
    if (Array.isArray(o)) {
      if (o.length === 2 && typeof o[0] === "number" && typeof o[1] === "number") {
        push(o[0], o[1]);
        return;
      }
      for (const x of o) walk(x);
    } else if (o && typeof o === "object") {
      for (const k of Object.keys(o)) walk((o as Record<string, unknown>)[k]);
    }
  };
  walk(JSON.parse(readFileSync("public/berlin-transit.json", "utf8")));
  return pts;
}

// ------------------------------------------------------------------ stats
const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

function summarise(v: number[]) {
  const s = [...v].sort((a, b) => a - b);
  return {
    n: v.length,
    median: pct(s, 50),
    p95: pct(s, 95),
    p99: pct(s, 99),
    max: s[s.length - 1],
  };
}

const f = (x: number, d = 3) => x.toFixed(d);

// ------------------------------------------------------------------- run
const PAIRS = 10_000;
const MAX_RANGE_M = 400; // the pipeline's thresholds all sit below this
const THRESHOLDS: Array<[string, number]> = [
  ["path resample spacing", 65],
  ["place candidate radius", 220],
  ["transit line corridor", 230],
  ["display / tightness", 245],
  ["photo merge radius", 300],
];

const pts = operatingPoints();
const lat = pts.map((p) => p[0]);
const lng = pts.map((p) => p[1]);
console.log("=".repeat(74));
console.log("PROJECTION ERROR — local equirectangular vs WGS-84 geodesic");
console.log("=".repeat(74));
console.log(`operating points from bundled data : ${pts.length.toLocaleString()}`);
console.log(
  `latitude range                     : ${f(Math.min(...lat), 5)} .. ${f(Math.max(...lat), 5)} N` +
    `  (span ${f(Math.max(...lat) - Math.min(...lat), 4)} deg)`
);
console.log(
  `longitude range                    : ${f(Math.min(...lng), 5)} .. ${f(Math.max(...lng), 5)} E` +
    `  (span ${f(Math.max(...lng) - Math.min(...lng), 4)} deg)`
);
console.log(`reference latitude in geo.ts       : 52.52 N`);
console.log(`sampled pairs                      : ${PAIRS.toLocaleString()} (seed 20260727)`);
console.log(`separation range                   : 1 .. ${MAX_RANGE_M} m\n`);

// --- 1. error over the operating range -----------------------------------
const rand = rng(20260727);
const absErr: number[] = [];
const relErr: number[] = [];
const byLat = new Map<string, number[]>();
const byDist = new Map<string, number[]>();
let maxCase = { err: 0, lat: 0, bearing: 0, trueD: 0 };

for (let i = 0; i < PAIRS; i++) {
  const a = pts[Math.floor(rand() * pts.length)];
  const bearing = rand() * 2 * Math.PI;
  const trueD = 1 + rand() * (MAX_RANGE_M - 1);
  const b = vincentyDirect(a, bearing, trueD);
  const e = dist(a, b) - trueD;
  absErr.push(Math.abs(e));
  relErr.push(Math.abs(e / trueD) * 100);
  if (Math.abs(e) > Math.abs(maxCase.err)) {
    maxCase = { err: e, lat: a[0], bearing: deg(bearing), trueD };
  }
  const lb = `${(Math.floor(a[0] * 10) / 10).toFixed(1)}`;
  (byLat.get(lb) ?? byLat.set(lb, []).get(lb)!).push(Math.abs(e));
  const db =
    trueD < 100 ? "  1-100 m" : trueD < 200 ? "100-200 m" : trueD < 300 ? "200-300 m" : "300-400 m";
  (byDist.get(db) ?? byDist.set(db, []).get(db)!).push(Math.abs(e));
}

const A_ = summarise(absErr);
const R_ = summarise(relErr);
console.log("1. ABSOLUTE ERROR (metres)");
console.log(`   median ${f(A_.median)}   p95 ${f(A_.p95)}   p99 ${f(A_.p99)}   max ${f(A_.max)}`);
console.log("2. RELATIVE ERROR (per cent)");
console.log(`   median ${f(R_.median)}   p95 ${f(R_.p95)}   p99 ${f(R_.p99)}   max ${f(R_.max)}`);
console.log(
  `   worst case: ${f(maxCase.err)} m at ${f(maxCase.lat, 4)} N, ` +
    `bearing ${f(maxCase.bearing, 1)} deg, true separation ${f(maxCase.trueD, 1)} m\n`
);

console.log("3. ABSOLUTE ERROR BY LATITUDE BAND (metres)");
console.log("   band        n        median      p95       max");
for (const k of [...byLat.keys()].sort()) {
  const s = summarise(byLat.get(k)!);
  console.log(
    `   ${k} N   ${String(s.n).padStart(6)}   ${f(s.median).padStart(8)}  ` +
      `${f(s.p95).padStart(8)}  ${f(s.max).padStart(8)}`
  );
}

console.log("\n4. ABSOLUTE ERROR BY SEPARATION (metres)");
console.log("   band          n        median      p95       max");
for (const k of [...byDist.keys()].sort()) {
  const s = summarise(byDist.get(k)!);
  console.log(
    `   ${k}   ${String(s.n).padStart(6)}   ${f(s.median).padStart(8)}  ` +
      `${f(s.p95).padStart(8)}  ${f(s.max).padStart(8)}`
  );
}

// --- 2. does the error ever move a point across a threshold? -------------
console.log("\n5. THRESHOLD DECISION FLIPS");
console.log("   For each threshold the true separation is drawn from the band in which a");
console.log("   flip is arithmetically possible, so this is a worst-case test rather than");
console.log("   a representative one.\n");
console.log("   threshold                      band tested        n      flips      rate");

const BAND = Math.max(1, Math.ceil(A_.max * 2));
for (const [name, T] of THRESHOLDS) {
  const r2 = rng(99000 + T);
  let flips = 0;
  const N = 200_000;
  for (let i = 0; i < N; i++) {
    const a = pts[Math.floor(r2() * pts.length)];
    const trueD = T - BAND + r2() * 2 * BAND;
    const b = vincentyDirect(a, r2() * 2 * Math.PI, trueD);
    if (trueD <= T !== dist(a, b) <= T) flips++;
  }
  console.log(
    `   ${(name + " (" + T + " m)").padEnd(30)} ±${BAND} m   ${String(N).padStart(8)}` +
      `   ${String(flips).padStart(6)}   ${f((flips / N) * 100, 4).padStart(8)}%`
  );
}

// --- 3. sphere vs ellipsoid, for context ---------------------------------
const r3 = rng(4242);
const hv: number[] = [];
for (let i = 0; i < PAIRS; i++) {
  const a = pts[Math.floor(r3() * pts.length)];
  const trueD = 1 + r3() * (MAX_RANGE_M - 1);
  const b = vincentyDirect(a, r3() * 2 * Math.PI, trueD);
  hv.push(Math.abs(haversine(a, b) - trueD));
}
const H_ = summarise(hv);
console.log("\n6. FOR CONTEXT — spherical haversine against the same reference (metres)");
console.log(`   median ${f(H_.median)}   p95 ${f(H_.p95)}   max ${f(H_.max)}`);

// --- 4. what a per-journey reference latitude would buy ------------------
// The error above is driven almost entirely by how far a point sits from the
// single hard-coded reference latitude. A journey spans a few kilometres, not
// the whole data extent, so anchoring the projection per journey should remove
// most of it. This measures that without changing the shipped code.
function distAt(a: LL, b: LL, lat0: number): number {
  const mLat = 111320;
  const mLng = 111320 * Math.cos(rad(lat0));
  return Math.hypot((a[1] - b[1]) * mLng, (a[0] - b[0]) * mLat);
}

const r4 = rng(20260727); // same stream as section 1, so pairs are identical
const dynErr: number[] = [];
for (let i = 0; i < PAIRS; i++) {
  const a = pts[Math.floor(r4() * pts.length)];
  const bearing = r4() * 2 * Math.PI;
  const trueD = 1 + r4() * (MAX_RANGE_M - 1);
  const b = vincentyDirect(a, bearing, trueD);
  dynErr.push(Math.abs(distAt(a, b, (a[0] + b[0]) / 2) - trueD));
}
const D_ = summarise(dynErr);
console.log("\n7. IF THE REFERENCE LATITUDE WERE ANCHORED PER JOURNEY (metres)");
console.log(`   median ${f(D_.median)}   p95 ${f(D_.p95)}   p99 ${f(D_.p99)}   max ${f(D_.max)}`);
console.log(
  `   improvement over the fixed reference: ${f(A_.max / Math.max(D_.max, 1e-9), 1)}x on the maximum`
);

console.log("\n" + "=".repeat(74));
console.log(
  `VERDICT: worst-case absolute error ${f(A_.max)} m over the operating range;\n` +
    `         a threshold decision can only change when the true separation lies\n` +
    `         within ${f(A_.max)} m of that threshold.`
);
console.log("=".repeat(74));
