"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  buildDayMap,
  layoutLabels,
  pointAtLength,
  postcardSvgString,
  statLine,
  POSTCARD_FONT,
  POSTCARD_THEME as T,
} from "./dayMap";
import type { PhotoAnchor } from "./photos";
import { GhostButton, PrimaryButton } from "./ui";

const MARKER_R = 14;

/** Rasterise the standalone postcard SVG to a PNG Blob, entirely client-side. */
async function renderPng(svg: string, width: number, height: number): Promise<Blob> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const img = new Image();
    img.decoding = "async";
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Could not render the postcard image."));
      img.src = url;
    });
    const scale = 2; // retina-crisp export
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable on this device.");
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/png")
    );
    if (!blob) throw new Error("Could not encode the postcard image.");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function DayReplay({
  anchors,
  dayKey,
}: {
  anchors: PhotoAnchor[];
  dayKey: string | null;
}) {
  const model = useMemo(() => buildDayMap(anchors, { dayKey }), [anchors, dayKey]);
  const labels = useMemo(() => layoutLabels(model), [model]);
  const duration = useMemo(
    () => Math.min(6000, Math.max(2600, model.points.length * 650)),
    [model]
  );

  // Starts undrawn: the route is meant to be watched appearing, and seeding
  // this at 1 made the finished map flash for a frame before the replay reset
  // it to zero.
  const [progress, setProgress] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const rafRef = useRef(0);
  const startRef = useRef<number | null>(null);
  const fromRef = useRef(0);

  const stop = () => cancelAnimationFrame(rafRef.current);

  const run = (from: number) => {
    stop();
    fromRef.current = from >= 1 ? 0 : from;
    startRef.current = null;
    setPlaying(true);
    const tick = (ts: number) => {
      if (startRef.current == null) startRef.current = ts;
      const p = Math.min(1, fromRef.current + (ts - startRef.current) / duration);
      setProgress(p);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
      else setPlaying(false);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  // Auto-play the day once whenever a new route is built. The kickoff is deferred
  // to a frame callback so no state is set synchronously inside the effect body.
  // Reduced motion gets the finished map instead of the drawing: this is a
  // requestAnimationFrame loop, so the stylesheet's reduce rules cannot stop it.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        setProgress(1);
        setPlaying(false);
        return;
      }
      run(0);
    });
    return () => {
      cancelAnimationFrame(id);
      stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  const togglePlay = () => (playing ? (stop(), setPlaying(false)) : run(progress));

  const drawn = progress * model.totalLength;
  const dashOffset = model.totalLength * (1 - progress);
  const head = pointAtLength(model, drawn);
  const isRevealed = (i: number) => drawn + 0.5 >= model.cumLengths[i] || i === 0;

  const savePostcard = async () => {
    setSaving(true);
    setStatus(null);
    try {
      const blob = await renderPng(postcardSvgString(model), model.width, model.height);
      const filename = `berlin-day-${dayKey && /^\d{4}-\d{2}-\d{2}$/.test(dayKey) ? dayKey : "trace"}.png`;
      const file = new File([blob], filename, { type: "image/png" });
      const nav = navigator as Navigator & {
        canShare?: (data?: ShareData) => boolean;
      };
      if (nav.canShare?.({ files: [file] }) && nav.share) {
        try {
          await nav.share({
            files: [file],
            title: "My day in Berlin",
            text: "My day in Berlin, rebuilt from my own photos.",
          });
          setStatus("Shared.");
          return;
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") return; // user cancelled
          // fall through to a plain download
        }
      }
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = filename;
      link.click();
      URL.revokeObjectURL(link.href);
      setStatus("Saved to your device.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save the postcard.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="lf-replay">
      <header className="lf-replay-header">
        <strong>Your day, drawn from your photos</strong>
        <span>{statLine(model)}</span>
      </header>

      <div className="lf-replay-card">
        <svg
          viewBox={`0 0 ${model.width} ${model.height}`}
          className="lf-replay-svg"
          role="img"
          aria-label={`Map of ${model.stopsText} across Berlin on ${model.dateText}`}
        >
          <defs>
            <linearGradient id="dr-bg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor={T.bgFrom} />
              <stop offset="1" stopColor={T.bgTo} />
            </linearGradient>
            <linearGradient id="dr-route" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor={T.routeFrom} />
              <stop offset="1" stopColor={T.routeTo} />
            </linearGradient>
            <pattern id="dr-dots" width="26" height="26" patternUnits="userSpaceOnUse">
              <circle cx="1.5" cy="1.5" r="1.1" fill={T.grid} />
            </pattern>
            <filter id="dr-glow" x="-30%" y="-30%" width="160%" height="160%">
              <feGaussianBlur stdDeviation="7" result="b" />
              <feMerge>
                <feMergeNode in="b" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <rect width={model.width} height={model.height} fill="url(#dr-bg)" />
          <rect width={model.width} height={model.height} fill="url(#dr-dots)" />

          <text x="66" y="44" fontFamily={POSTCARD_FONT} fontSize="12" fontWeight="700" letterSpacing="3" fill={T.eyebrow}>
            A DAY IN BERLIN
          </text>
          <text x="66" y="76" fontFamily={POSTCARD_FONT} fontSize="26" fontWeight="700" fill={T.title}>
            {model.dateText}
          </text>
          <text x="66" y="98" fontFamily={POSTCARD_FONT} fontSize="13" fill={T.subtitle}>
            {statLine(model)}
          </text>

          {/* faint full route + the bright, progressively-drawn route */}
          <path d={model.pathD} fill="none" stroke={T.routeFaint} strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
          <path
            d={model.pathD}
            fill="none"
            stroke="url(#dr-route)"
            strokeWidth="4.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            filter="url(#dr-glow)"
            strokeDasharray={model.totalLength}
            strokeDashoffset={dashOffset}
          />

          {/* moving head while the day is playing out */}
          {progress < 1 && (
            <circle cx={head.x} cy={head.y} r="6" fill={T.dot} stroke={T.markerRing} strokeWidth="2" />
          )}

          {model.points.map((p, i) => {
            const label = labels[i];
            const shown = isRevealed(i);
            return (
              <g key={p.index} className="lf-replay-stop" data-shown={shown ? "" : undefined}>
                <rect x={label.chipX} y={label.chipY} width={label.chipW} height={label.chipH} fill={T.chipBg} stroke={T.chipStroke} />
                <text x={label.textX} y={label.textY} fontFamily={POSTCARD_FONT} fontSize="13" fill={T.chipText} dominantBaseline="middle">
                  {label.text}
                </text>
                <circle cx={p.x} cy={p.y} r={MARKER_R} fill={T.marker} stroke={T.markerRing} strokeWidth="3" />
                <text x={p.x} y={p.y + 0.5} fontFamily={POSTCARD_FONT} fontSize="13" fontWeight="700" fill={T.markerText} textAnchor="middle" dominantBaseline="middle">
                  {p.index}
                </text>
              </g>
            );
          })}

          <text x="66" y={model.height - 26} fontFamily={POSTCARD_FONT} fontSize="11.5" fill={T.footer}>
            Rebuilt on your device from photo metadata — images never uploaded
          </text>
        </svg>
      </div>

      <div className="lf-replay-controls">
        <GhostButton
          onClick={togglePlay}
          className="lf-replay-action"
        >
          {playing ? "⏸ Pause" : progress >= 1 ? "↻ Replay" : "▶ Play"}
        </GhostButton>
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(progress * 1000)}
          onChange={(e) => {
            stop();
            setPlaying(false);
            setProgress(Number(e.target.value) / 1000);
          }}
          aria-label="Scrub through the day"
          className="lf-replay-range"
        />
        <PrimaryButton
          disabled={saving}
          onClick={savePostcard}
          className="lf-replay-action"
        >
          {saving ? "Saving…" : "Save postcard"}
        </PrimaryButton>
      </div>

      <p className="lf-replay-note">
        {status ??
          "Nothing lost? Keep it as a souvenir of your Berlin day. The map is drawn entirely on your device."}
      </p>
    </div>
  );
}
