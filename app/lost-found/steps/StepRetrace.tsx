"use client";

import { useMemo, useState } from "react";
import { CATEGORY_META } from "../../berlin-transit/attractions";
import { polylineLength } from "../../berlin-transit/geo";
import { inferJourney } from "../../berlin-transit/transit";
import { toOfflineRoutePlan, type OfflineRoutePlan } from "../offlineRoute";
import {
  fetchVbbTraceJourneys,
  formatDateTimeLocal,
  type LiveJourneyCandidate,
  type ModeFilter,
} from "../../berlin-transit/vbb";
import {
  fetchInferenceNetwork,
  searchItems,
  type SearchItem,
  type SourceIndex,
} from "../data";
import JourneyInference from "../JourneyInference";
import {
  extractPhotoPoints,
  reconstructPhotoAnchors,
  type PhotoAnchor,
} from "../photos";
import type { ItineraryEntry } from "../types";
import { cx } from "../ui";

const ALL_MODES: ModeFilter = {
  subway: true,
  light_rail: true,
  tram: true,
  bus: true,
  rail: true,
  ferry: true,
};

function LineSwatch({ item }: { item: SearchItem }) {
  return (
    <span
      className="inline-flex min-w-[2.4rem] items-center justify-center rounded-md px-1.5 py-0.5 text-xs font-bold text-white shadow-sm"
      style={{ backgroundColor: item.color || "#57534e" }}
    >
      {item.label}
    </span>
  );
}

function ItemRow({
  item,
  added,
  onToggle,
}: {
  item: SearchItem;
  added: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cx(
        "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition",
        added
          ? "border-orange-300 bg-orange-50 dark:border-orange-500/50 dark:bg-orange-500/10"
          : "border-stone-200 hover:border-stone-300 hover:bg-stone-50 dark:border-stone-700 dark:hover:border-stone-600 dark:hover:bg-stone-800/60"
      )}
    >
      {item.kind === "line" ? (
        <LineSwatch item={item} />
      ) : (
        <span className="text-lg leading-none">
          {item.category ? CATEGORY_META[item.category].emoji : "📍"}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-stone-800 dark:text-stone-100">
          {item.label}
        </span>
        <span className="block truncate text-xs text-stone-400">{item.sublabel}</span>
      </span>
      <span
        className={cx(
          "flex h-6 w-6 flex-none items-center justify-center rounded-full text-sm font-bold",
          added ? "bg-orange-600 text-white" : "bg-stone-100 text-stone-400 dark:bg-stone-700"
        )}
      >
        {added ? "✓" : "+"}
      </span>
    </button>
  );
}

export default function StepRetrace({
  index,
  loading,
  sourceError,
  itinerary,
  lostDate,
  timeFrom,
  onAdd,
  onRemove,
  onRetrySources,
}: {
  index: SourceIndex | null;
  loading: boolean;
  sourceError: string | null;
  itinerary: ItineraryEntry[];
  lostDate: string;
  timeFrom?: string;
  onAdd: (item: SearchItem) => void;
  onRemove: (uid: string) => void;
  onRetrySources: () => void;
}) {
  const [query, setQuery] = useState("");
  const [photoBusy, setPhotoBusy] = useState(false);
  const [inferenceBusy, setInferenceBusy] = useState(false);
  const [photoMsg, setPhotoMsg] = useState<string | null>(null);
  const [anchors, setAnchors] = useState<PhotoAnchor[]>([]);
  const [candidates, setCandidates] = useState<LiveJourneyCandidate[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState(0);
  const [offlinePlan, setOfflinePlan] = useState<OfflineRoutePlan | null>(null);
  const [routeNotice, setRouteNotice] = useState<string | null>(null);
  const addedRefs = useMemo(() => new Set(itinerary.map((e) => e.refId)), [itinerary]);

  const results = useMemo(
    () => (index ? searchItems(index, query) : []),
    [index, query]
  );

  const toggle = (item: SearchItem) => {
    const existing = itinerary.find((e) => e.refId === item.refId);
    if (existing) onRemove(existing.uid);
    else onAdd(item);
  };

  const inferredItems = useMemo(() => {
    if (!index) return [];
    const items = new Map<string, SearchItem>();
    const merge = (
      item: SearchItem,
      journey?: NonNullable<SearchItem["journeys"]>[number],
      operator?: NonNullable<SearchItem["operators"]>[number]
    ) => {
      const existing = items.get(item.refId);
      const journeys = [...(existing?.journeys ?? [])];
      const operators = [...(existing?.operators ?? item.operators ?? [])];
      if (journey) {
        const signature = JSON.stringify(journey);
        if (!journeys.some((candidate) => JSON.stringify(candidate) === signature)) {
          journeys.push(journey);
        }
      }
      if (operator && !operators.some((candidate) => candidate.id === operator.id)) {
        operators.push(operator);
      }
      items.set(item.refId, {
        ...(existing ?? item),
        journeys: journeys.length ? journeys : undefined,
        operators: operators.length ? operators : undefined,
      });
    };
    for (const anchor of anchors) {
      if (anchor.venue) merge(anchor.venue);
    }

    const selected = candidates[selectedCandidate];
    for (const leg of selected?.legs ?? []) {
      if (leg.walking || !leg.lineRef) continue;
      const line = index.items.find(
        (item) =>
          item.kind === "line" &&
          (item.refId === leg.lineId ||
            (item.label === leg.lineRef && (!leg.mode || item.mode === leg.mode)))
      );
      if (line) {
        merge(
          line,
          {
            from: leg.originName,
            to: leg.destinationName,
            departure: leg.departure,
            direction: leg.direction ?? undefined,
          },
          leg.operator ?? undefined
        );
      }
    }
    const photoDeparture = anchors.find((anchor) => anchor.time != null)?.time;
    for (const [segmentIndex, segment] of (offlinePlan?.segments ?? []).entries()) {
      if (segment.priority !== "high") continue;
      const line = index.items.find(
        (item) => item.kind === "line" && item.refId === segment.lineId
      );
      if (line) {
        merge(line, {
          from: segment.from,
          to: segment.to,
          departure:
            segmentIndex === 0
              ? photoDeparture != null
                ? new Date(photoDeparture).toISOString()
                : `${lostDate}T${timeFrom || "09:00"}`
              : undefined,
        });
      }
    }
    return [...items.values()];
  }, [
    anchors,
    candidates,
    index,
    lostDate,
    offlinePlan,
    selectedCandidate,
    timeFrom,
  ]);

  const inferredUsed =
    inferredItems.length > 0 &&
    inferredItems.every((item) => {
      const existing = itinerary.find((entry) => entry.refId === item.refId);
      if (!existing) return false;
      const existingOperatorIds = new Set(
        (existing.operators ?? []).map((operator) => operator.id)
      );
      if (
        item.operators?.some(
          (operator) => !existingOperatorIds.has(operator.id)
        )
      ) {
        return false;
      }
      if (!item.journeys?.length) return true;
      const existingJourneys = new Set(
        (existing.journeys ?? []).map((journey) => JSON.stringify(journey))
      );
      return item.journeys.every((journey) =>
        existingJourneys.has(JSON.stringify(journey))
      );
    });

  const useInferredItinerary = () => {
    for (const item of inferredItems) {
      onAdd(item);
    }
  };

  // Add a single line from the offline estimate (append, not swap a segment).
  const addLineById = (lineId: string) => {
    if (!index || itinerary.some((entry) => entry.refId === lineId)) return;
    const item = index.items.find((i) => i.kind === "line" && i.refId === lineId);
    const segment = offlinePlan?.segments.find((candidate) => candidate.lineId === lineId);
    if (item) {
      onAdd({
        ...item,
        journeys: segment
          ? [{ from: segment.from, to: segment.to }]
          : undefined,
      });
    }
  };

  const handlePhotos = async (input: HTMLInputElement) => {
    const files = input.files ? Array.from(input.files) : [];
    input.value = ""; // allow re-picking the same photos
    if (!files.length || !index) return;
    setPhotoBusy(true);
    setPhotoMsg(null);
    setAnchors([]);
    setCandidates([]);
    setSelectedCandidate(0);
    setOfflinePlan(null);
    setRouteNotice(null);
    try {
      const { points, total, withGps } = await extractPhotoPoints(files);
      const venues = index.items.filter((i) => i.kind === "venue" && i.point);
      const reconstructed = reconstructPhotoAnchors(points, venues);
      setAnchors(reconstructed);

      if (withGps === 0) {
        setPhotoMsg(`Read ${total} photo${total === 1 ? "" : "s"} · none had location data.`);
        return;
      }

      setPhotoMsg(
        `Read ${total} · ${withGps} with location · ${reconstructed.length} route ${
          reconstructed.length === 1 ? "anchor" : "anchors"
        } after grouping nearby photos.`
      );

      const drawn = reconstructed.map((anchor) => anchor.point);
      if (drawn.length < 2 || polylineLength(drawn) < 150) {
        setRouteNotice(
          "We found the photo location, but need two places at least a few blocks apart to infer transport."
        );
      } else {
        setRouteNotice(
          "Photo locations are ready. Comparing them with VBB is optional and only starts when you press the button below."
        );
      }
    } catch (error) {
      setPhotoMsg(
        error instanceof Error
          ? `Couldn't read those photos: ${error.message}`
          : "Couldn't read those photos on this device."
      );
    } finally {
      setPhotoBusy(false);
    }
  };

  const compareWithVbb = async () => {
    const drawn = anchors.map((anchor) => anchor.point);
    if (drawn.length < 2 || polylineLength(drawn) < 150) return;
    setInferenceBusy(true);
    setCandidates([]);
    setSelectedCandidate(0);
    setOfflinePlan(null);
    setRouteNotice(null);
    const firstTime = anchors.find((anchor) => anchor.time != null)?.time;
    const departure =
      firstTime != null
        ? formatDateTimeLocal(new Date(firstTime))
        : `${lostDate || formatDateTimeLocal(new Date()).slice(0, 10)}T${timeFrom || "09:00"}`;
    try {
      const network = await fetchInferenceNetwork();
      try {
        const journeys = await fetchVbbTraceJourneys({
          drawn,
          departure,
          modes: ALL_MODES,
          lines: network.lines,
        });
        setCandidates(journeys);
        setRouteNotice(
          "This is a likely schedule-valid route, not proof. Pick another option if it better matches your memory."
        );
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : "VBB returned an unknown error.";
        const fallback = inferJourney(drawn, network.lines);
        setOfflinePlan(
          fallback
            ? toOfflineRoutePlan(fallback, { referenceTime: firstTime ?? departure })
            : null
        );
        setRouteNotice(
          fallback
            ? `VBB could not verify this trip: ${reason} The result below is an on-device, geometry-only estimate.`
            : `VBB could not verify this trip: ${reason} The photo anchors are still usable, but no offline transit line matched reliably.`
        );
      }
    } catch (error) {
      setRouteNotice(
        error instanceof Error
          ? error.message
          : "The transit data needed for route inference could not be loaded."
      );
    } finally {
      setInferenceBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-stone-500 dark:text-stone-400">
        Start with the places and lines you remember. Add every realistic
        possibility; we combine entries that lead to the same lost-property
        office.
      </p>

      {/* Selected itinerary */}
      {itinerary.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {itinerary.map((entry) => (
            <span
              key={entry.uid}
              className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 bg-white py-1 pl-2.5 pr-1.5 text-sm dark:border-stone-700 dark:bg-stone-900"
            >
              <span className="font-medium text-stone-700 dark:text-stone-200">{entry.label}</span>
              <button
                type="button"
                onClick={() => onRemove(entry.uid)}
                aria-label={`Remove ${entry.label}`}
                className="flex h-5 w-5 items-center justify-center rounded-full text-stone-400 hover:bg-stone-100 hover:text-stone-600 dark:hover:bg-stone-700"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search a line or place: U5, S7, Museumsinsel, Alexanderplatz…"
        className="w-full rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm outline-none transition placeholder:text-stone-400 focus:border-orange-400 focus:ring-2 focus:ring-orange-100 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:focus:ring-orange-500/20"
      />

      {sourceError && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200"
        >
          <span>{sourceError} Search, quick-add and photo matching are unavailable.</span>
          <button
            type="button"
            onClick={onRetrySources}
            className="rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-red-700 shadow-sm dark:bg-stone-900 dark:text-red-200"
          >
            Retry
          </button>
        </div>
      )}

      {/* Quick add when no query */}
      {!query && index && (
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-400">
              Common U-Bahn / S-Bahn · tap to add
            </p>
            <div className="flex flex-wrap gap-1.5">
              {index.quickLines.map((item) => {
                const added = addedRefs.has(item.refId);
                return (
                  <button
                    key={item.refId}
                    type="button"
                    onClick={() => toggle(item)}
                    className={cx(
                      "rounded-md px-2 py-1 text-xs font-bold text-white transition",
                      added ? "opacity-100 ring-2 ring-orange-400 ring-offset-1 dark:ring-offset-stone-950" : "opacity-90 hover:opacity-100"
                    )}
                    style={{ backgroundColor: item.color || "#57534e" }}
                  >
                    {item.label}
                  </button>
                );
              })}
            </div>
          </div>

          {index.quickVenues.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-stone-400">
                Popular sights · tap to add
              </p>
              <div className="flex flex-wrap gap-1.5">
                {index.quickVenues.map((item) => {
                  const added = addedRefs.has(item.refId);
                  return (
                    <button
                      key={item.refId}
                      type="button"
                      onClick={() => toggle(item)}
                      className={cx(
                        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium transition",
                        added
                          ? "border-orange-400 bg-orange-50 text-orange-700 dark:border-orange-500/60 dark:bg-orange-500/10 dark:text-orange-300"
                          : "border-stone-200 text-stone-600 hover:border-stone-300 dark:border-stone-700 dark:text-stone-300 dark:hover:border-stone-600"
                      )}
                    >
                      <span className="leading-none">
                        {item.category ? CATEGORY_META[item.category].emoji : "📍"}
                      </span>
                      {item.label}
                      <span className={added ? "text-orange-500" : "text-stone-400"}>
                        {added ? "✓" : "+"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Results */}
      {loading && <p className="text-sm text-stone-400">Loading Berlin lines and sights…</p>}
      {query && !sourceError && (
        <div className="space-y-1.5">
          {results.length === 0 ? (
            <p className="text-sm text-stone-400">No lines or places match “{query}”.</p>
          ) : (
            results.map((item) => (
              <ItemRow
                key={`${item.kind}-${item.refId}`}
                item={item}
                added={addedRefs.has(item.refId)}
                onToggle={() => toggle(item)}
              />
            ))
          )}
        </div>
      )}

      <details className="group rounded-2xl border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900">
        <summary className="cursor-pointer list-none px-4 py-3.5 text-sm font-semibold text-stone-700 dark:text-stone-200">
          <span className="group-open:hidden">
            📷 Use photos to remember your route (optional) ▾
          </span>
          <span className="hidden group-open:inline">
            Hide photo route helper ▴
          </span>
        </summary>
        <div className="space-y-4 border-t border-stone-100 p-4 dark:border-stone-800">
          <p className="text-xs leading-relaxed text-stone-500 dark:text-stone-400">
            Choose photos from that day. We read their time and location on
            this device to suggest nearby sights. The images are never
            uploaded. A timetable comparison happens only if you choose it
            separately.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <label
              className={cx(
                "inline-flex cursor-pointer items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold text-white transition",
                photoBusy || !index
                  ? "bg-stone-300 dark:bg-stone-700"
                  : "bg-orange-600 hover:bg-orange-500"
              )}
            >
              {photoBusy ? "Reading on your device…" : "Choose photos"}
              <input
                type="file"
                accept="image/*"
                multiple
                disabled={photoBusy || !index}
                onChange={(e) => handlePhotos(e.currentTarget)}
                className="hidden"
              />
            </label>
            {photoMsg && (
              <span className="text-xs text-stone-500 dark:text-stone-400">
                {photoMsg}
              </span>
            )}
          </div>

          <JourneyInference
            anchors={anchors}
            busy={photoBusy || inferenceBusy}
            busyMessage={
              photoBusy
                ? "Reading photo locations and capture times on this device."
                : "Comparing the possible route with Berlin’s timetable."
            }
            candidates={candidates}
            selectedIndex={selectedCandidate}
            offlinePlan={offlinePlan}
            addedRefs={addedRefs}
            notice={routeNotice}
            used={inferredUsed}
            onSelect={setSelectedCandidate}
            onUse={useInferredItinerary}
            onAddLine={addLineById}
            canCompare={
              !photoBusy &&
              !inferenceBusy &&
              candidates.length === 0 &&
              !offlinePlan &&
              anchors.length >= 2 &&
              polylineLength(anchors.map((anchor) => anchor.point)) >= 150
            }
            onCompare={compareWithVbb}
          />
        </div>
      </details>
    </div>
  );
}
