"use client";

import type { LL } from "../berlin-transit/geo";
import { modeLabel } from "../berlin-transit/transit";
import type { LiveJourneyCandidate, LiveJourneyLeg } from "../berlin-transit/vbb";
import type { OfflineRoutePlan, PrioritizedLine, SearchPriority } from "./offlineRoute";
import type { PhotoAnchor } from "./photos";
import { Badge, PrimaryButton } from "./ui";

const PRIORITY_META: Record<
  SearchPriority,
  { label: string; tone: "success" | "warning" | "neutral" }
> = {
  high: { label: "High priority", tone: "success" },
  medium: { label: "Medium", tone: "warning" },
  low: { label: "Low", tone: "neutral" },
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
    <li className="lf-priority-row">
      <span
        className="lf-transit-badge"
        style={{ backgroundColor: line.color, color: line.textColor }}
      >
        {line.ref}
      </span>
      <span className="lf-priority-copy">
        <span className="lf-priority-meta">
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <small>{modeLabel(line.mode)}</small>
        </span>
        <span className="lf-priority-detail">
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
          className={`lf-inline-add${added ? " is-added" : ""}`}
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
  const date = new Date(value);
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
  const scale = Math.min(
    (width - padding * 2) / spanX,
    (height - padding * 2) / spanY
  );
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
  const offlinePoints = offlineLines.flatMap((line) =>
    line.matchedPolylines.flat()
  );
  const allPoints = [...routePoints, ...offlinePoints, ...anchorPoints];
  if (allPoints.length < 2) return null;
  const project = buildProjection(allPoints);

  return (
    <div className="lf-journey-sketch">
      <svg
        viewBox="0 0 320 142"
        role="img"
        aria-label={
          offlinePlan
            ? "Search corridor showing the primary inferred route, alternative lines, and photo anchors"
            : "Schematic map of the inferred route and photo anchors"
        }
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
        <rect width="320" height="142" fill="url(#route-grid)" />
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
              stroke="var(--lf-red)"
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
            stroke="var(--lf-red)"
            strokeWidth="4"
            strokeDasharray="5 5"
            strokeLinecap="round"
          />
        )}
        {anchors.map((anchor, index) => {
          const [x, y] = project(anchor.point);
          return (
            <g key={anchor.id} transform={`translate(${x} ${y})`}>
              <circle r="9" fill="white" stroke="var(--lf-red)" strokeWidth="2.5" />
              <text
                x="0"
                y="3"
                textAnchor="middle"
                fontSize="8"
                fontWeight="800"
                fill="var(--lf-red)"
              >
                {index + 1}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="lf-journey-sketch-caption">
        {offlinePlan
          ? "Possible route · solid primary · faded alternatives"
          : "Route diagram"}{" "}
        · {anchors.length} photo {anchors.length === 1 ? "location" : "locations"}
      </div>
    </div>
  );
}

function AnchorList({ anchors }: { anchors: PhotoAnchor[] }) {
  return (
    <ol className="lf-anchor-list lf-stagger" aria-label="Photo location anchors">
      {anchors.map((anchor, index) => (
        <li key={anchor.id}>
          <span className="lf-anchor-index">{index + 1}</span>
          <span className="lf-anchor-copy">
            <span>
              <strong>{anchor.venue?.label ?? "Photo location"}</strong>
              <time>{formatTime(anchor.time)}</time>
            </span>
            <small>
              {anchor.venue && anchor.distanceM != null
                ? `${Math.round(anchor.distanceM)} m from this sight`
                : `${anchor.point[0].toFixed(4)}, ${anchor.point[1].toFixed(4)}`}
              {anchor.photoCount > 1 ? ` · ${anchor.photoCount} photos` : ""}
            </small>
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
}) {
  const journey = candidates[selectedIndex] ?? null;
  if (!busy && anchors.length === 0) return null;

  const canUse =
    anchors.some((anchor) => anchor.venue) ||
    Boolean(journey) ||
    Boolean(offlinePlan?.segments.some((segment) => segment.priority === "high"));

  return (
    <section className="lf-journey">
      {busy ? (
        <div className="lf-journey-busy" role="status">
          <span className="lf-journey-pulse" />
          <span>
            <strong>Rebuilding your day…</strong>
            <small>
              {busyMessage ?? "Ordering photo anchors and comparing likely journeys."}
            </small>
          </span>
        </div>
      ) : (
        <>
          <header className="lf-journey-header">
            <div>
              <div className="lf-journey-kicker">
                <span>Suggested route</span>
                <Badge tone={journey ? "success" : "warning"}>
                  {journey
                    ? "Matches the timetable"
                    : offlinePlan
                      ? "Best estimate"
                      : "Photo locations only"}
                </Badge>
              </div>
              <h3>
                {journey
                  ? lineSummary(journey)
                  : offlinePlan
                    ? offlinePlan.segments.map((segment) => segment.ref).join(" → ")
                    : anchors.length > 1
                      ? `${anchors.length} places in time order`
                      : "One location found"}
              </h3>
              <p>Check this before adding it to the search plan.</p>
            </div>
          </header>

          {candidates.length > 1 && (
            <div className="lf-route-options" aria-label="Journey alternatives">
              {candidates.slice(0, 4).map((candidate, index) => (
                <button
                  key={candidate.id}
                  type="button"
                  aria-pressed={selectedIndex === index}
                  onClick={() => onSelect(index)}
                  className={selectedIndex === index ? "is-active" : undefined}
                >
                  <strong>Option {index + 1} · {Math.round(candidate.similarity)}%</strong>
                  <small>{formatTime(candidate.departure)} · {lineSummary(candidate)}</small>
                </button>
              ))}
            </div>
          )}

          <RouteSketch anchors={anchors} journey={journey} offlinePlan={offlinePlan} />
          <AnchorList anchors={anchors} />

          {journey && (
            <>
              <div className="lf-journey-stats">
                <div><strong>{journey.durationMinutes} min</strong><small>travel time</small></div>
                <div><strong>{journey.transfers}</strong><small>transfers</small></div>
                <div><strong>{Math.round(journey.coverage * 100)}%</strong><small>photo stops matched</small></div>
              </div>

              <h4 className="lf-journey-section-title">Likely movements</h4>
              <ol className="lf-journey-movements lf-stagger">
                {visibleLegs(journey).map((leg) => (
                  <li key={leg.id}>
                    <span
                      className="lf-transit-badge"
                      style={{ backgroundColor: leg.color, color: leg.textColor }}
                    >
                      {leg.walking ? "Walk" : leg.lineRef}
                    </span>
                    <span className="lf-journey-leg-copy">
                      <span>
                        <strong>{formatTime(leg.departure)} → {formatTime(leg.arrival)}</strong>
                        <small>{durationLabel(leg)}</small>
                      </span>
                      <span>{leg.originName} → {leg.destinationName}</span>
                      {!leg.walking && leg.direction && <small>Direction: {leg.direction}</small>}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}

          {offlinePlan && !journey && (
            <div className="lf-priority-sections">
              <section>
                <h4>Possible route <small>· ranked by search priority</small></h4>
                <ol className="lf-stagger" aria-label="Offline route estimate">
                  {offlinePlan.segments.map((line, index) => (
                    <PriorityRow
                      key={`${line.lineId}-seg-${index}`}
                      line={line}
                      added={addedRefs?.has(line.lineId) ?? false}
                      onAdd={onAddLine}
                    />
                  ))}
                </ol>
              </section>
              {offlinePlan.alternatives.length > 0 && (
                <section>
                  <h4>Other lines in the corridor</h4>
                  <ol className="lf-stagger" aria-label="Alternative lines in the search corridor">
                    {offlinePlan.alternatives.map((line, index) => (
                      <PriorityRow
                        key={`${line.lineId}-alt-${index}`}
                        line={line}
                        added={addedRefs?.has(line.lineId) ?? false}
                        onAdd={onAddLine}
                      />
                    ))}
                  </ol>
                </section>
              )}
            </div>
          )}

          {notice && <p className="lf-journey-notice">{notice}</p>}

          {canUse && (
            <PrimaryButton
              onClick={onUse}
              disabled={used}
              className={`lf-journey-use${used ? " is-complete" : ""}`}
            >
              {used ? "✓ Added to your search plan" : "Use this itinerary"}
            </PrimaryButton>
          )}
        </>
      )}
    </section>
  );
}
