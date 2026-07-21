// Pure geometry + path-matching helpers. No DOM / Leaflet dependencies so this
// can be unit-reasoned about and reused on server or client.

export type LL = [number, number]; // [lat, lng]

// Local equirectangular projection anchored at central Berlin. Over the ~40km
// span of the city the distortion from treating lat/lng as a flat meter grid is
// negligible for the distances we care about (tens to hundreds of meters).
const LAT0 = 52.52;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = 111320 * Math.cos((LAT0 * Math.PI) / 180);

function xy([lat, lng]: LL): [number, number] {
  return [lng * M_PER_DEG_LNG, lat * M_PER_DEG_LAT];
}

/** Great-circle-ish distance in meters (flat-earth approx, fine for a city). */
export function dist(a: LL, b: LL): number {
  const [ax, ay] = xy(a);
  const [bx, by] = xy(b);
  return Math.hypot(ax - bx, ay - by);
}

/** Shortest distance in meters from point p to segment a-b. */
export function pointToSegment(p: LL, a: LL, b: LL): number {
  const [px, py] = xy(p);
  const [ax, ay] = xy(a);
  const [bx, by] = xy(b);
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Min distance in meters from a point to a polyline. */
export function pointToPolyline(p: LL, poly: LL[]): number {
  let min = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const d = pointToSegment(p, poly[i - 1], poly[i]);
    if (d < min) min = d;
  }
  return min;
}

/** Total length of a polyline in meters. */
export function polylineLength(poly: LL[]): number {
  let sum = 0;
  for (let i = 1; i < poly.length; i++) sum += dist(poly[i - 1], poly[i]);
  return sum;
}

/**
 * Resample a path so vertices are evenly spaced by `spacing` meters. This makes
 * coverage scoring independent of how fast/slow the user dragged the pointer.
 */
export function resample(path: LL[], spacing: number): LL[] {
  const clean: LL[] = [];
  for (const p of path) {
    if (!clean.length || dist(p, clean[clean.length - 1]) > 0.5) clean.push(p);
  }
  if (clean.length < 2) return clean;
  const out: LL[] = [clean[0]];
  let acc = 0;
  for (let i = 1; i < clean.length; i++) {
    let a = clean[i - 1];
    const b = clean[i];
    let segLen = dist(a, b);
    while (acc + segLen >= spacing && segLen > 0) {
      const remain = spacing - acc;
      const t = remain / segLen;
      const np: LL = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      out.push(np);
      a = np;
      segLen = dist(a, b);
      acc = 0;
    }
    acc += segLen;
  }
  const last = clean[clean.length - 1];
  if (dist(out[out.length - 1], last) > 0.5) out.push(last);
  return out;
}

export type BBox = [number, number, number, number]; // [minLat, minLng, maxLat, maxLng]

export function bboxOf(pts: LL[], padMeters = 0): BBox {
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  for (const [lat, lng] of pts) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }
  const padLat = padMeters / M_PER_DEG_LAT;
  const padLng = padMeters / M_PER_DEG_LNG;
  return [minLat - padLat, minLng - padLng, maxLat + padLat, maxLng + padLng];
}

export function bboxIntersect(a: BBox, b: BBox): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

export function pointInBbox(point: LL, box: BBox, padMeters = 0): boolean {
  const padLat = padMeters / M_PER_DEG_LAT;
  const padLng = padMeters / M_PER_DEG_LNG;
  return (
    point[0] >= box[0] - padLat &&
    point[0] <= box[2] + padLat &&
    point[1] >= box[1] - padLng &&
    point[1] <= box[3] + padLng
  );
}
