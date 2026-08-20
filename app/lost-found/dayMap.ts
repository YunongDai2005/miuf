// Pure geometry + text for the "your day in Berlin" postcard. No DOM, no JSX, so
// it can be unit-reasoned about and shared by the interactive replay (DayReplay)
// and the deterministic PNG export. Everything here stays on-device: it only ever
// consumes photo anchors the traveller already reconstructed locally.

import { CATEGORY_META } from "../berlin-transit/attractions";
import { dist, type LL } from "../berlin-transit/geo";
import { berlinDayKey, formatBerlinDay, type PhotoAnchor } from "./photos";

/** A single "night map" palette so the preview and the exported postcard match. */
export const POSTCARD_THEME = {
  bgFrom: "#10161c",
  bgTo: "#10161c",
  glow: "#d8232a",
  grid: "rgba(148,163,184,0.10)",
  routeFaint: "rgba(216,35,42,0.18)",
  routeFrom: "#d8232a",
  routeTo: "#d8232a",
  dot: "#f3f4f6",
  marker: "#f8fafc",
  markerRing: "#d8232a",
  markerText: "#10161c",
  eyebrow: "#d8232a",
  title: "#f8fafc",
  subtitle: "rgba(226,232,240,0.75)",
  chipBg: "rgba(9,14,28,0.78)",
  chipStroke: "rgba(148,163,184,0.25)",
  chipText: "#f1f5f9",
  footer: "rgba(148,163,184,0.55)",
} as const;

export const POSTCARD_FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// Card geometry. The inner region (where markers live) is inset to leave room for
// the title block up top and the footer at the bottom.
const W = 800;
const H = 520;
const PAD_X = 66;
const PAD_TOP = 108;
const PAD_BOTTOM = 54;
const MARKER_R = 14;
const CHIP_H = 27;

export interface DayMapPoint {
  x: number;
  y: number;
  index: number; // 1-based stop number
  label: string;
  emoji: string;
  isVenue: boolean;
  time: number | null;
}

export interface DayMapModel {
  width: number;
  height: number;
  points: DayMapPoint[];
  /** SVG path string through every stop, in time order. */
  pathD: string;
  /** Cumulative on-screen (px) length of the route at each stop. */
  cumLengths: number[];
  totalLength: number;
  /** Real-world route length in kilometres. */
  distanceKm: number;
  dateText: string;
  timeText: string; // "09:14 – 17:32", or "" when no photo carried a time
  stopsText: string; // "5 stops"
}

const berlinTime = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Europe/Berlin",
});

const LAT0 = 52.52;
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LNG = 111320 * Math.cos((LAT0 * Math.PI) / 180);

function metersXY([lat, lng]: LL): [number, number] {
  return [lng * M_PER_DEG_LNG, lat * M_PER_DEG_LAT];
}

function emojiFor(anchor: PhotoAnchor): string {
  if (anchor.venue?.category) return CATEGORY_META[anchor.venue.category].emoji;
  return "📷";
}

function labelFor(anchor: PhotoAnchor): string {
  return anchor.venue?.label ?? "Photo stop";
}

/**
 * Project the ordered photo anchors into the card's pixel space (fit-to-box,
 * uniform scale, Y flipped so north is up) and precompute everything the replay
 * and the export both need: the route path, per-stop cumulative lengths, the
 * real-world distance, and the title/stat strings.
 */
export function buildDayMap(
  anchors: PhotoAnchor[],
  opts: { dayKey?: string | null } = {}
): DayMapModel {
  const metres = anchors.map((a) => metersXY(a.point));
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of metres) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const innerW = W - 2 * PAD_X;
  const innerH = H - PAD_TOP - PAD_BOTTOM;
  const sx = spanX > 1e-6 ? innerW / spanX : Infinity;
  const sy = spanY > 1e-6 ? innerH / spanY : Infinity;
  let scale = Math.min(sx, sy);
  if (!Number.isFinite(scale)) scale = 1; // all anchors coincide
  const offsetX = PAD_X + (innerW - spanX * scale) / 2;
  const offsetY = PAD_TOP + (innerH - spanY * scale) / 2;

  const points: DayMapPoint[] = anchors.map((anchor, i) => {
    const [mx, my] = metres[i];
    return {
      x: offsetX + (mx - minX) * scale,
      y: offsetY + (maxY - my) * scale, // flip so north is up
      index: i + 1,
      label: labelFor(anchor),
      emoji: emojiFor(anchor),
      isVenue: Boolean(anchor.venue),
      time: anchor.time,
    };
  });

  const cumLengths: number[] = [0];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    cumLengths.push(total);
  }

  const pathD = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");

  let metresTotal = 0;
  for (let i = 1; i < anchors.length; i++) {
    metresTotal += dist(anchors[i - 1].point, anchors[i].point);
  }

  const times = anchors
    .map((a) => a.time)
    .filter((t): t is number => t != null)
    .sort((a, b) => a - b);
  const timeText =
    times.length === 0
      ? ""
      : times.length === 1
        ? berlinTime.format(times[0])
        : `${berlinTime.format(times[0])} – ${berlinTime.format(times[times.length - 1])}`;

  const dateKey =
    opts.dayKey && /^\d{4}-\d{2}-\d{2}$/.test(opts.dayKey)
      ? opts.dayKey
      : berlinDayKey(times[0] ?? null);
  const dateText = dateKey ? formatBerlinDay(dateKey) : "Your day in Berlin";

  return {
    width: W,
    height: H,
    points,
    pathD,
    cumLengths,
    totalLength: total,
    distanceKm: Math.round((metresTotal / 1000) * 10) / 10,
    dateText,
    timeText,
    stopsText: `${points.length} ${points.length === 1 ? "stop" : "stops"}`,
  };
}

/** One line of the stat row, e.g. "5 stops · 8.4 km · 09:14 – 17:32". */
export function statLine(model: DayMapModel): string {
  return [model.stopsText, `${model.distanceKm} km`, model.timeText]
    .filter(Boolean)
    .join("  ·  ");
}

/** Interpolate a point at `targetLen` pixels along the route. */
export function pointAtLength(
  model: DayMapModel,
  targetLen: number
): { x: number; y: number } {
  const { points, cumLengths, totalLength } = model;
  if (points.length === 0) return { x: model.width / 2, y: model.height / 2 };
  const clamped = Math.max(0, Math.min(totalLength, targetLen));
  for (let i = 1; i < points.length; i++) {
    if (clamped <= cumLengths[i]) {
      const segLen = cumLengths[i] - cumLengths[i - 1] || 1;
      const t = (clamped - cumLengths[i - 1]) / segLen;
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
      };
    }
  }
  const last = points[points.length - 1];
  return { x: last.x, y: last.y };
}

export interface DayMapLabel {
  index: number;
  chipX: number;
  chipY: number;
  chipW: number;
  chipH: number;
  textX: number;
  textY: number;
  text: string;
}

function chipText(point: DayMapPoint): string {
  return `${point.emoji} ${point.label}`;
}

function chipWidth(text: string): number {
  // Approximate: emoji ~ 1.6 chars, everything else ~ 7px at the 13px label size.
  return Math.round(20 + text.length * 7);
}

/**
 * Place a name chip beside each stop. Chips sit to the right by default, flip to
 * the left near the right edge, and clamp vertically so nothing leaves the card.
 * Deterministic so the live preview and the exported postcard render identically.
 */
export function layoutLabels(model: DayMapModel): DayMapLabel[] {
  const top = 96;
  const bottom = model.height - 40;
  return model.points.map((point) => {
    const text = chipText(point);
    const chipW = chipWidth(text);
    const gap = MARKER_R + 10;
    let chipX = point.x + gap;
    if (chipX + chipW > model.width - 8) chipX = point.x - gap - chipW; // flip left
    chipX = Math.max(8, Math.min(model.width - 8 - chipW, chipX));
    let chipY = point.y - CHIP_H / 2;
    chipY = Math.max(top, Math.min(bottom - CHIP_H, chipY));
    return {
      index: point.index,
      chipX,
      chipY,
      chipW,
      chipH: CHIP_H,
      textX: chipX + 11,
      textY: chipY + CHIP_H / 2,
      text,
    };
  });
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;"
  );
}

/**
 * Build the fully-revealed postcard as a standalone, self-contained SVG string
 * (no external fonts, images or foreignObject) so it rasterises cleanly to PNG.
 * This is the shareable artefact; the interactive component mirrors its look.
 */
export function postcardSvgString(model: DayMapModel): string {
  const t = POSTCARD_THEME;
  const labels = layoutLabels(model);
  const stat = statLine(model);

  const markers = model.points
    .map((p) => {
      const label = labels[p.index - 1];
      return `
    <g>
      <rect x="${label.chipX.toFixed(1)}" y="${label.chipY.toFixed(1)}" width="${label.chipW}" height="${label.chipH}" fill="${t.chipBg}" stroke="${t.chipStroke}"/>
      <text x="${label.textX.toFixed(1)}" y="${label.textY.toFixed(1)}" font-family="${POSTCARD_FONT}" font-size="13" fill="${t.chipText}" dominant-baseline="middle">${escapeXml(label.text)}</text>
      <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${MARKER_R}" fill="${t.marker}" stroke="${t.markerRing}" stroke-width="3"/>
      <text x="${p.x.toFixed(1)}" y="${(p.y + 0.5).toFixed(1)}" font-family="${POSTCARD_FONT}" font-size="13" font-weight="700" fill="${t.markerText}" text-anchor="middle" dominant-baseline="middle">${p.index}</text>
    </g>`;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${model.width}" height="${model.height}" viewBox="0 0 ${model.width} ${model.height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.bgFrom}"/>
      <stop offset="1" stop-color="${t.bgTo}"/>
    </linearGradient>
    <linearGradient id="route" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${t.routeFrom}"/>
      <stop offset="1" stop-color="${t.routeTo}"/>
    </linearGradient>
    <pattern id="dots" width="26" height="26" patternUnits="userSpaceOnUse">
      <circle cx="1.5" cy="1.5" r="1.1" fill="${t.grid}"/>
    </pattern>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="7" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="${model.width}" height="${model.height}" fill="url(#bg)"/>
  <rect width="${model.width}" height="${model.height}" fill="url(#dots)"/>
  <text x="${PAD_X}" y="44" font-family="${POSTCARD_FONT}" font-size="12" font-weight="700" letter-spacing="3" fill="${t.eyebrow}">A DAY IN BERLIN</text>
  <text x="${PAD_X}" y="76" font-family="${POSTCARD_FONT}" font-size="26" font-weight="700" fill="${t.title}">${escapeXml(model.dateText)}</text>
  <text x="${PAD_X}" y="98" font-family="${POSTCARD_FONT}" font-size="13" fill="${t.subtitle}">${escapeXml(stat)}</text>
  <text x="${model.width - PAD_X}" y="52" font-family="${POSTCARD_FONT}" font-size="12" fill="${t.subtitle}" text-anchor="end">N ↑</text>
  <path d="${model.pathD}" fill="none" stroke="${t.routeFaint}" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="${model.pathD}" fill="none" stroke="url(#route)" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" filter="url(#glow)"/>
  ${markers}
  <text x="${PAD_X}" y="${model.height - 26}" font-family="${POSTCARD_FONT}" font-size="11.5" fill="${t.footer}">Rebuilt on your device from photo metadata — images never uploaded · Berlin Lost &amp; Found</text>
</svg>`;
}
