"use client";

import type { LL } from "../berlin-transit/geo";
import { modeLabel } from "../berlin-transit/transit";
import type { LiveJourneyCandidate, LiveJourneyLeg } from "../berlin-transit/vbb";
import type { OfflineRoutePlan, PrioritizedLine, SearchPriority } from "./offlineRoute";
import type { PhotoAnchor } from "./photos";
import { cx } from "./ui";

const PRIORITY_META: Record<SearchPriority, { label: string; className: string }> = {
  high: {
    label: "High priority",
    className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  },
  medium: {
    label: "Medium",
    className: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  },
  low: {
    label: "Low",
    className: "bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-400",
  },
};

function PriorityRow({
  line,
  added,
  onAdd,
}: {
  line: PrioritizedLine;
  added: boolean;
  onAdd?: (lineId: string) => void;
}) {
  const meta = PRIORITY_META[line.priority];
  return (
    <li className="flex items-center gap-3 rounded-xl bg-stone-50 p-2.5 dark:bg-stone-800/70">
      <span
        className="inline-flex h-8 min-w-10 flex-none items-center justify-center rounded-lg px-1.5 text-[10px] font-extrabold shadow-sm"
        style={{ backgroundColor: line.color, color: line.textColor }}
      >
        {line.ref}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className={cx("rounded-full px-2 py-0.5 text-[9px] font-semibold", meta.className)}>
            {meta.label}
          </span>
          <span className="text-[9px] tabular-nums text-stone-400">
            {line.routeMatch}% confidence
          </span>
          <span className="text-[9px] text-stone-400">{modeLabel(line.mode)}</span>
        </span>
        <span className="mt-0.5 block truncate text-[10px] text-stone-400">
          {line.from && line.to
            ? `${line.from} → ${line.to}`
            : `≈ ${line.matchedLengthKm.toFixed(1)} km along your photo path`}
          {line.timingNote ? ` · ${line.timingNote}` : ""}
        </span>
      </span>
      {onAdd && (
        <button
          type="button"
          disabled={added}
          onClick={() => onAdd(line.lineId)}
          aria-label={added ? `${line.ref} added` : `Add ${line.ref}`}
          className={cx(
            "flex h-7 w-7 flex-none items-center justify-center rounded-full text-sm font-bold transition",
            added
              ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300"
              : "bg-stone-200 text-stone-500 hover:bg-orange-600 hover:text-white dark:bg-stone-700"
          )}
        >
          {added ? "✓" : "+"}
        </button>
      )}
    </li>
  );
}

type Projection = (point: LL) => [number, number];

function formatTime(value: string | number | null) {
  if (!value) return "time unknown";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "time unknown";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function visibleLegs(journey: LiveJourneyCandidate) {
  return journey.legs.filter((leg) => {
    if (!leg.walking) return true;
    const duration = Date.parse(leg.arrival) - Date.parse(leg.departure);
    return !(
      Number.isFinite(duration) &&
      duration <= 0 &&
      leg.originName === leg.destinationName
    );
  });
}

function lineSummary(journey: LiveJourneyCandidate) {
  const refs = journey.legs
    .filter((leg) => !leg.walking)
    .map((leg) => leg.lineRef)
    .filter((ref): ref is string => Boolean(ref))
    .filter((ref, index, all) => ref !== all[index - 1]);
  return refs.length ? refs.join(" → ") : "No transit line found";
}

function durationLabel(leg: LiveJourneyLeg) {
  const duration = Date.parse(leg.arrival) - Date.parse(leg.departure);
  if (!Number.isFinite(duration) || duration <= 0) return null;
  return `${Math.max(1, Math.round(duration / 60_000))} min`;
}

function buildProjection(points: LL[]): Projection {
  const width = 320;
  const height = 142;
  const padding = 18;
  const latitudes = points.map((point) => point[0]);
  const longitudes = points.map((point) => point[1]);
  const minLat = Math.min(...latitudes);
  const maxLat = Math.max(...latitudes);
  const minLng = Math.min(...longitudes);
  const maxLng = Math.max(...longitudes);
  const meanLat = (minLat + maxLat) / 2;
  const lngScale = Math.max(0.25, Math.cos((meanLat * Math.PI) / 180));
  const spanX = Math.max((maxLng - minLng) * lngScale, 0.0005);
  const spanY = Math.max(maxLat - minLat, 0.0005);
  const scale = Math.min((width - padding * 2) / spanX, (height - padding * 2) / spanY);
  const usedWidth = spanX * scale;
  const usedHeight = spanY * scale;
  const offsetX = (width - usedWidth) / 2;
  const offsetY = (height - usedHeight) / 2;

  return ([lat, lng]) => [
    offsetX + (lng - minLng) * lngScale * scale,
    offsetY + (maxLat - lat) * scale,
  ];
}

function pathData(points: LL[], project: Projection) {
  return points
    .map((point, index) => {
      const [x, y] = project(point);
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");
}

function RouteSketch({
  anchors,
  journey,
  offlinePlan,
}: {
  anchors: PhotoAnchor[];
  journey: LiveJourneyCandidate | null;
  offlinePlan: OfflineRoutePlan | null;
}) {
  const anchorPoints = anchors.map((anchor) => anchor.point);
  const routePoints = journey?.polyline.length ? journey.polyline : anchorPoints;
  const offlineLines = offlinePlan
    ? [...offlinePlan.alternatives, ...offlinePlan.segments]
    : [];
  const offlinePoints = offlineLines.flatMap((line) => line.matchedPolylines.flat());
  const allPoints = [...routePoints, ...offlinePoints, ...anchorPoints];
  if (allPoints.length < 2) return null;
  const project = buildProjection(allPoints);

  return (
    <div className="relative mt-4 overflow-hidden rounded-2xl border border-stone-200 bg-stone-100 dark:border-stone-700 dark:bg-stone-900">
      <svg
        viewBox="0 0 320 142"
        role="img"
        aria-label={
          offlinePlan
            ? "Search corridor showing the primary inferred route, alternative lines, and photo anchors"
            : "Schematic map of the inferred route and photo anchors"
        }
        className="block h-36 w-full"
      >
        <defs>
          <pattern id="route-grid" width="24" height="24" patternUnits="userSpaceOnUse">
            <path
              d="M 24 0 L 0 0 0 24"
              fill="none"
              stroke="currentColor"
              strokeOpacity="0.08"
              strokeWidth="1"
            />
          </pattern>
        </defs>
        <rect width="320" height="142" fill="url(#route-grid)" className="text-stone-500" />
        <path
          d={pathData(routePoints, project)}
          fill="none"
          stroke="white"
          strokeOpacity="0.9"
          strokeWidth="8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {journey ? (
          visibleLegs(journey).map((leg) =>
            leg.polyline.length >= 2 ? (
              <path
                key={leg.id}
                d={pathData(leg.polyline, project)}
                fill="none"
                stroke={leg.color}
                strokeWidth={leg.walking ? 3 : 5}
                strokeDasharray={leg.walking ? "3 5" : undefined}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : null
          )
        ) : offlinePlan ? (
          <>
            <path
              d={pathData(anchorPoints, project)}
              fill="none"
              stroke="#f97316"
              strokeOpacity="0.7"
              strokeWidth="3"
              strokeDasharray="5 5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {offlinePlan.alternatives.map((line, lineIndex) =>
              line.matchedPolylines.map((polyline, polylineIndex) =>
                polyline.length >= 2 ? (
                  <path
                    key={`${line.lineId}-alt-${lineIndex}-${polylineIndex}`}
                    d={pathData(polyline, project)}
                    fill="none"
                    stroke={line.color}
                    strokeOpacity={line.priority === "medium" ? 0.48 : 0.25}
                    strokeWidth={line.priority === "medium" ? 5 : 4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ) : null
              )
            )}
            {offlinePlan.segments.map((line, lineIndex) =>
              line.matchedPolylines.map((polyline, polylineIndex) =>
                polyline.length >= 2 ? (
                  <path
                    key={`${line.lineId}-segment-${lineIndex}-${polylineIndex}`}
                    d={pathData(polyline, project)}
                    fill="none"
                    stroke={line.color}
                    strokeOpacity={line.priority === "high" ? 0.95 : 0.35}
                    strokeWidth={line.priority === "high" ? 6 : 4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                ) : null
              )
            )}
          </>
        ) : (
          <path
            d={pathData(routePoints, project)}
            fill="none"
            stroke="#f97316"
            strokeWidth="4"
            strokeDasharray="5 5"
            strokeLinecap="round"
          />
        )}
        {anchors.map((anchor, index) => {
          const [x, y] = project(anchor.point);
          return (
            <g key={anchor.id} transform={`translate(${x} ${y})`}>
              <circle r="9" fill="white" stroke="#ea580c" strokeWidth="2.5" />
              <text
                x="0"
                y="3"
                textAnchor="middle"
                fontSize="8"
                fontWeight="800"
                fill="#c2410c"
              >
                {index + 1}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="absolute bottom-2 left-2 rounded-full bg-white/90 px-2 py-1 text-[9px] font-semibold text-stone-500 shadow-sm backdrop-blur dark:bg-stone-950/85 dark:text-stone-300">
        {offlinePlan
          ? "Possible route · solid primary · faded alternatives"
          : "Schematic"}{" "}
        · {anchors.length} photo {anchors.length === 1 ? "location" : "locations"}
      </div>
    </div>
  );
}

function AnchorList({ anchors }: { anchors: PhotoAnchor[] }) {
  return (
    <ol className="mt-4 grid gap-2 sm:grid-cols-2" aria-label="Photo location anchors">
      {anchors.map((anchor, index) => (
        <li
          key={anchor.id}
          className="flex min-w-0 items-center gap-2.5 rounded-xl bg-stone-50 px-3 py-2 dark:bg-stone-800/70"
        >
          <span className="flex h-6 w-6 flex-none items-center justify-center rounded-full bg-orange-100 text-[10px] font-bold text-orange-700 dark:bg-orange-500/15 dark:text-orange-300">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex items-center justify-between gap-2">
              <span className="truncate text-[11px] font-semibold text-stone-700 dark:text-stone-200">
                {anchor.venue?.label ?? "Photo location"}
              </span>
              <span className="flex-none text-[10px] tabular-nums text-stone-400">
                {formatTime(anchor.time)}
              </span>
            </span>
            <span className="mt-0.5 block truncate text-[9px] text-stone-400">
              {anchor.venue && anchor.distanceM != null
                ? `${Math.round(anchor.distanceM)} m from this sight`
                : `${anchor.point[0].toFixed(4)}, ${anchor.point[1].toFixed(4)}`}
              {anchor.photoCount > 1 ? ` · ${anchor.photoCount} photos` : ""}
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

export default function JourneyInference({
  anchors,
  busy,
  busyMessage,
  candidates,
  selectedIndex,
  offlinePlan,
  addedRefs,
  notice,
  used,
  onSelect,
  onUse,
  onAddLine,
  canCompare,
  onCompare,
}: {
  anchors: PhotoAnchor[];
  busy: boolean;
  busyMessage?: string;
  candidates: LiveJourneyCandidate[];
  selectedIndex: number;
  offlinePlan: OfflineRoutePlan | null;
  addedRefs?: Set<string>;
  notice: string | null;
  used: boolean;
  onSelect: (index: number) => void;
  onUse: () => void;
  onAddLine?: (lineId: string) => void;
  canCompare?: boolean;
  onCompare?: () => void;
}) {
  const journey = candidates[selectedIndex] ?? null;
  if (!busy && anchors.length === 0) return null;

  const confidence = journey
    ? Math.round(journey.similarity)
    : offlinePlan
      ? Math.round(offlinePlan.confidence * 100)
      : null;
  const canUse =
    anchors.some((anchor) => anchor.venue) ||
    Boolean(journey) ||
    Boolean(offlinePlan?.segments.some((segment) => segment.priority === "high"));

  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-4 shadow-sm dark:border-stone-700 dark:bg-stone-900">
      {busy ? (
        <div className="flex items-center gap-3 py-3" role="status">
          <span className="relative h-3 w-3 rounded-full bg-orange-500 after:absolute after:inset-[-5px] after:animate-ping after:rounded-full after:bg-orange-400/30" />
          <span>
            <span className="block text-sm font-semibold text-stone-800 dark:text-stone-100">
              Rebuilding your day…
            </span>
            <span className="mt-0.5 block text-[11px] text-stone-400">
              {busyMessage ?? "Ordering photo anchors and comparing likely journeys."}
            </span>
          </span>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-orange-700 dark:text-orange-400">
                  Suggested route
                </p>
                <span
                  className={cx(
                    "rounded-full px-2 py-0.5 text-[9px] font-semibold",
                    journey
                      ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                      : "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300"
                  )}
                >
                  {journey
                    ? "Matches the timetable"
                    : offlinePlan
                      ? "Best estimate"
                      : "Photo locations only"}
                </span>
              </div>
              <h3 className="mt-1 truncate text-base font-bold text-stone-900 dark:text-stone-50">
                {journey
                  ? lineSummary(journey)
                  : offlinePlan
                    ? offlinePlan.segments.map((segment) => segment.ref).join(" → ")
                    : anchors.length > 1
                      ? `${anchors.length} places in time order`
                      : "One location found"}
              </h3>
              <p className="mt-1 text-[11px] text-stone-400">
                Check this before adding it to the search plan.
              </p>
            </div>
            {confidence != null && (
              <div className="flex-none text-right">
                <div className="text-base font-bold tabular-nums text-orange-600">{confidence}%</div>
                <div className="text-[9px] text-stone-400">route confidence</div>
              </div>
            )}
          </div>

          {candidates.length > 1 && (
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1" aria-label="Journey alternatives">
              {candidates.slice(0, 4).map((candidate, index) => (
                <button
                  key={candidate.id}
                  type="button"
                  aria-pressed={selectedIndex === index}
                  onClick={() => onSelect(index)}
                  className={cx(
                    "flex-none rounded-xl border px-3 py-2 text-left transition",
                    selectedIndex === index
                      ? "border-orange-400 bg-orange-50 dark:border-orange-500/70 dark:bg-orange-500/10"
                      : "border-stone-200 hover:border-stone-300 dark:border-stone-700 dark:hover:border-stone-600"
                  )}
                >
                  <span className="block text-[10px] font-semibold text-stone-700 dark:text-stone-200">
                    Option {index + 1} · {Math.round(candidate.similarity)}%
                  </span>
                  <span className="mt-0.5 block max-w-36 truncate text-[9px] text-stone-400">
                    {formatTime(candidate.departure)} · {lineSummary(candidate)}
                  </span>
                </button>
              ))}
            </div>
          )}

          <RouteSketch anchors={anchors} journey={journey} offlinePlan={offlinePlan} />
          <AnchorList anchors={anchors} />

          {journey && (
            <>
              <div className="mt-4 grid grid-cols-3 divide-x divide-stone-200 rounded-xl border border-stone-200 bg-stone-50 py-2.5 text-center dark:divide-stone-700 dark:border-stone-700 dark:bg-stone-800/70">
                <div>
                  <div className="text-xs font-semibold tabular-nums">{journey.durationMinutes} min</div>
                  <div className="text-[9px] text-stone-400">travel time</div>
                </div>
                <div>
                  <div className="text-xs font-semibold tabular-nums">{journey.transfers}</div>
                  <div className="text-[9px] text-stone-400">transfers</div>
                </div>
                <div>
                  <div className="text-xs font-semibold tabular-nums">
                    {Math.round(journey.coverage * 100)}%
                  </div>
                  <div className="text-[9px] text-stone-400">photo stops matched</div>
                </div>
              </div>

              <h4 className="mt-4 text-[11px] font-bold text-stone-700 dark:text-stone-200">
                Likely movements
              </h4>
              <ol className="relative mt-1 space-y-1 before:absolute before:bottom-4 before:left-[21px] before:top-4 before:w-px before:bg-stone-200 dark:before:bg-stone-700">
                {visibleLegs(journey).map((leg) => (
                  <li key={leg.id} className="relative flex items-start gap-3 rounded-xl px-2 py-2.5">
                    <span
                      className="relative z-10 inline-flex h-8 min-w-10 flex-none items-center justify-center rounded-lg border-2 border-white px-1.5 text-[10px] font-extrabold shadow-sm dark:border-stone-900"
                      style={{ backgroundColor: leg.color, color: leg.textColor }}
                    >
                      {leg.walking ? "Walk" : leg.lineRef}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold tabular-nums text-stone-700 dark:text-stone-200">
                          {formatTime(leg.departure)} → {formatTime(leg.arrival)}
                        </span>
                        <span className="text-[9px] text-stone-400">{durationLabel(leg)}</span>
                      </span>
                      <span className="mt-0.5 block text-[10px] text-stone-500 dark:text-stone-400">
                        {leg.originName} → {leg.destinationName}
                      </span>
                      {!leg.walking && leg.direction && (
                        <span className="mt-0.5 block truncate text-[9px] text-stone-400">
                          Direction: {leg.direction}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}

          {offlinePlan && !journey && (
            <div className="mt-4 space-y-3">
              <div>
                <h4 className="text-[11px] font-bold text-stone-700 dark:text-stone-200">
                  Possible route{" "}
                  <span className="font-normal text-stone-400">
                    · ranked by search priority
                  </span>
                </h4>
                <ol className="mt-1 space-y-1" aria-label="Offline route estimate">
                  {offlinePlan.segments.map((line, index) => (
                    <PriorityRow
                      key={`${line.lineId}-seg-${index}`}
                      line={line}
                      added={addedRefs?.has(line.lineId) ?? false}
                      onAdd={onAddLine}
                    />
                  ))}
                </ol>
              </div>
              {offlinePlan.alternatives.length > 0 && (
                <div>
                  <h4 className="text-[11px] font-bold text-stone-700 dark:text-stone-200">
                    Other lines in the corridor
                  </h4>
                  <ol className="mt-1 space-y-1" aria-label="Alternative lines in the search corridor">
                    {offlinePlan.alternatives.map((line, index) => (
                      <PriorityRow
                        key={`${line.lineId}-alt-${index}`}
                        line={line}
                        added={addedRefs?.has(line.lineId) ?? false}
                        onAdd={onAddLine}
                      />
                    ))}
                  </ol>
                </div>
              )}
            </div>
          )}

          {notice && (
            <p className="mt-3 rounded-xl bg-amber-50 px-3 py-2 text-[10px] leading-relaxed text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
              {notice}
            </p>
          )}

          {canCompare && onCompare && (
            <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50 p-3 dark:border-sky-500/30 dark:bg-sky-500/10">
              <p className="text-[11px] font-semibold text-sky-900 dark:text-sky-200">
                Optional third-party route comparison
              </p>
              <p className="mt-1 text-[10px] leading-relaxed text-sky-800 dark:text-sky-300">
                If you continue, the photo route’s start, intermediate and end GPS coordinates,
                plus a departure timestamp, are sent to the community-run{" "}
                <a
                  href="https://v6.vbb.transport.rest/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2"
                >
                  v6.vbb.transport.rest
                </a>{" "}
                API. Your photos and their image contents are not sent.
              </p>
              <button
                type="button"
                onClick={onCompare}
                className="mt-2.5 inline-flex items-center justify-center rounded-lg bg-sky-700 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-sky-600"
              >
                Compare this route with VBB
              </button>
            </div>
          )}

          {canUse && (
            <button
              type="button"
              onClick={onUse}
              disabled={used}
              className={cx(
                "mt-4 flex w-full items-center justify-center rounded-xl px-4 py-2.5 text-sm font-semibold transition",
                used
                  ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"
                  : "bg-stone-900 text-white hover:bg-stone-700 dark:bg-orange-600 dark:hover:bg-orange-500"
              )}
            >
              {used ? "✓ Added to your search plan" : "Use this itinerary"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
