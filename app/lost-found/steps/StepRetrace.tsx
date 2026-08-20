"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import DayReplay from "../DayReplay";
import DateWindowPicker from "../DateWindowPicker";
import {
  dedupeByTime,
  extractPhotoPoints,
  filterPhotoPointsByDateWindow,
  formatBerlinDay,
  groupPhotoDays,
  reconstructPhotoAnchors,
  type PhotoAnchor,
  type PhotoDay,
  type PhotoPoint,
} from "../photos";
import {
  hasNativePhotoLibrary,
  importNativePhotoPoints,
  requestPhotoAuthorization,
} from "../photoLibrary";
import { lossDateWindow, type ItineraryEntry, type LostItem } from "../types";
import type { RoutePreview } from "../routePreview";

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
      className="lf-line-swatch"
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
      className={`lf-search-result${added ? " is-added" : ""}`}
    >
      {item.kind === "line" ? (
        <LineSwatch item={item} />
      ) : (
        <span className="lf-place-symbol">
          {item.category ? CATEGORY_META[item.category].emoji : "📍"}
        </span>
      )}
      <span className="lf-search-result-copy">
        <strong>{item.label}</strong>
        <small>{item.sublabel}</small>
      </span>
      <span className="lf-search-result-action">{added ? "✓" : "+"}</span>
    </button>
  );
}

export default function StepRetrace({
  view,
  index,
  loading,
  sourceError,
  itinerary,
  item,
  onItem,
  onAdd,
  onRemove,
  onRetrySources,
  initialRoutePreview,
  onRoutePreview,
}: {
  view: "search" | "photos";
  index: SourceIndex | null;
  loading: boolean;
  sourceError: string | null;
  itinerary: ItineraryEntry[];
  item: LostItem;
  onItem: (patch: Partial<LostItem>) => void;
  onAdd: (item: SearchItem) => void;
  onRemove: (uid: string) => void;
  onRetrySources: () => void;
  initialRoutePreview?: RoutePreview | null;
  onRoutePreview?: (preview: RoutePreview) => void;
}) {
  const [query, setQuery] = useState("");
  const [nativePhotos] = useState(hasNativePhotoLibrary);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [inferenceBusy, setInferenceBusy] = useState(false);
  const [photoMsg, setPhotoMsg] = useState<string | null>(null);
  const [photoProgress, setPhotoProgress] = useState<{ done: number; total: number } | null>(null);
  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [photoDays, setPhotoDays] = useState<PhotoDay[]>([]);
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(
    initialRoutePreview?.dayKey ?? null
  );
  const [anchors, setAnchors] = useState<PhotoAnchor[]>(
    initialRoutePreview?.anchors ?? []
  );
  const [candidates, setCandidates] = useState<LiveJourneyCandidate[]>(
    initialRoutePreview?.journey ? [initialRoutePreview.journey] : []
  );
  const [selectedCandidate, setSelectedCandidate] = useState(0);
  const [offlinePlan, setOfflinePlan] = useState<OfflineRoutePlan | null>(
    initialRoutePreview?.offlinePlan ?? null
  );
  const [routeNotice, setRouteNotice] = useState<string | null>(null);
  const inferenceRequest = useRef(0);
  const webPhotoInput = useRef<HTMLInputElement>(null);
  const selectedPhotoWindow = useRef(item);
  const addedRefs = useMemo(() => new Set(itinerary.map((e) => e.refId)), [itinerary]);
  const lostDate = item.lostDate;
  const timeFrom = item.timeFrom;
  const currentWindow = lossDateWindow(item);
  const currentWindowLabel =
    currentWindow.start === currentWindow.end
      ? formatBerlinDay(currentWindow.start)
      : `${formatBerlinDay(currentWindow.start)} – ${formatBerlinDay(currentWindow.end)}`;

  useEffect(() => {
    onRoutePreview?.({
      anchors,
      journey: candidates[selectedCandidate] ?? null,
      offlinePlan,
      dayKey: selectedDayKey,
    });
  }, [anchors, candidates, offlinePlan, onRoutePreview, selectedCandidate, selectedDayKey]);

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

  const dayKeyOf = (group: PhotoDay) => group.day ?? "unknown";

  // Narrow to a single day's photos, drop near-duplicate bursts, and rebuild
  // the route anchors. Called after extraction and whenever a day chip is tapped.
  const applyPhotoDay = (group: PhotoDay) => {
    if (!index) return;
    inferenceRequest.current += 1;
    setInferenceBusy(false);
    setSelectedDayKey(dayKeyOf(group));
    // A different day means any previously computed route no longer applies.
    setCandidates([]);
    setSelectedCandidate(0);
    setOfflinePlan(null);

    const deduped = dedupeByTime(group.points);
    const venues = index.items.filter((i) => i.kind === "venue" && i.point);
    const reconstructed = reconstructPhotoAnchors(deduped, venues);
    setAnchors(reconstructed);

    const removed = group.count - deduped.length;
    const dayLabel = group.day ? formatBerlinDay(group.day) : "photos without a date";
    setPhotoMsg(
      [
        `${dayLabel} · ${group.count} with location`,
        removed > 0
          ? `${deduped.length} after skipping ${removed} shot${removed === 1 ? "" : "s"} <1 min apart`
          : null,
        `${reconstructed.length} route ${reconstructed.length === 1 ? "anchor" : "anchors"}`,
      ]
        .filter(Boolean)
        .join(" · ")
    );

    const drawn = reconstructed.map((anchor) => anchor.point);
    if (drawn.length < 2 || polylineLength(drawn) < 150) {
      setRouteNotice(
        "We found the photo location, but need two places at least a few blocks apart to infer transport."
      );
    } else {
      void compareWithVbb(reconstructed);
    }
  };

  // Shared tail for both photo sources: bucket by day, auto-pick a day, apply it.
  const ingestPhotoPoints = (
    points: PhotoPoint[],
    total: number,
    withGps: number,
    selectedItem: LostItem = item
  ) => {
    if (withGps === 0) {
      setPhotoDays([]);
      setSelectedDayKey(null);
      setPhotoMsg(
        `Read ${total} photo${total === 1 ? "" : "s"} · none in this date window had both a capture time and location.`
      );
      return;
    }
    const days = groupPhotoDays(points);
    setPhotoDays(days);
    // An exact date remains the obvious first day. For an uncertain trip range,
    // surface the day with the richest location trail without claiming it is
    // the day the item was lost; all other candidate days remain available.
    const preferred =
      (selectedItem.dateCertainty !== "range"
        ? days.find((day) => day.day && day.day === selectedItem.lostDate)
        : undefined) ??
      [...days].sort((a, b) => b.count - a.count)[0];
    applyPhotoDay(preferred);
  };

  // Clear all photo-derived state before a fresh import (web file picker or native).
  const resetPhotoState = () => {
    inferenceRequest.current += 1;
    setPhotoMsg(null);
    setAnchors([]);
    setCandidates([]);
    setSelectedCandidate(0);
    setOfflinePlan(null);
    setRouteNotice(null);
    setPhotoDays([]);
    setSelectedDayKey(null);
  };

  const handlePhotos = async (input: HTMLInputElement) => {
    const files = input.files ? Array.from(input.files) : [];
    input.value = ""; // allow re-picking the same photos
    if (!files.length || !index) return;
    setPhotoBusy(true);
    resetPhotoState();
    setPhotoProgress({ done: 0, total: files.length });
    try {
      const { points, total } = await extractPhotoPoints(files, {
        onProgress: (done, totalFiles) => setPhotoProgress({ done, total: totalFiles }),
      });
      const selectedItem = selectedPhotoWindow.current;
      const { start, end } = lossDateWindow(selectedItem);
      const inWindow = filterPhotoPointsByDateWindow(points, start, end);
      ingestPhotoPoints(inWindow, total, inWindow.length, selectedItem);
    } catch (error) {
      setPhotoMsg(
        error instanceof Error
          ? `Couldn't read those photos: ${error.message}`
          : "Couldn't read those photos on this device."
      );
    } finally {
      setPhotoBusy(false);
      setPhotoProgress(null);
    }
  };

  // Native (iOS) path: the PhotoKit plugin reads geotag + capture time straight
  // from the photo library's metadata (no pixels decoded, nothing uploaded).
  // Restrict the native query to the reported loss day when available so even a
  // very large library does not have to be scanned or bridged into the WebView.
  const handleNativeImport = async (selectedItem: LostItem) => {
    if (!index) return;
    setPhotoBusy(true);
    resetPhotoState();
    setPhotoProgress(null);
    try {
      const status = await requestPhotoAuthorization();
      if (status === "denied" || status === "restricted") {
        setPhotoMsg(
          "Photo access is off. Turn it on for this app in Settings to import a day of photos."
        );
        return;
      }
      const { start, end } = lossDateWindow(selectedItem);
      const options =
        selectedItem.dateCertainty === "range"
          ? { startDate: start, endDate: end }
          : { day: start };
      const { total, withGps, points } = await importNativePhotoPoints(options);
      ingestPhotoPoints(points, total, withGps, selectedItem);
    } catch (error) {
      setPhotoMsg(
        error instanceof Error
          ? `Couldn't read your photo library: ${error.message}`
          : "Couldn't read your photo library on this device."
      );
    } finally {
      setPhotoBusy(false);
    }
  };

  const confirmPhotoWindow = (patch: Partial<LostItem>) => {
    const selectedItem = { ...item, ...patch };
    selectedPhotoWindow.current = selectedItem;
    onItem(patch);
    setDatePickerOpen(false);
    if (nativePhotos) {
      void handleNativeImport(selectedItem);
      return;
    }
    // A browser cannot query PhotoKit by date. Open its picker only after the
    // traveller has chosen a window, then discard out-of-window EXIF locally.
    window.setTimeout(() => webPhotoInput.current?.click(), 0);
  };

  const compareWithVbb = async (routeAnchors: PhotoAnchor[] = anchors) => {
    const drawn = routeAnchors.map((anchor) => anchor.point);
    if (drawn.length < 2 || polylineLength(drawn) < 150) return;
    const requestId = ++inferenceRequest.current;
    setInferenceBusy(true);
    setCandidates([]);
    setSelectedCandidate(0);
    setOfflinePlan(null);
    setRouteNotice("Automatically comparing the photo route with VBB…");
    const firstTime = routeAnchors.find((anchor) => anchor.time != null)?.time;
    const departure =
      firstTime != null
        ? formatDateTimeLocal(new Date(firstTime))
        : `${lostDate || formatDateTimeLocal(new Date()).slice(0, 10)}T${timeFrom || "09:00"}`;
    try {
      const network = await fetchInferenceNetwork();
      if (requestId !== inferenceRequest.current) return;
      try {
        const journeys = await fetchVbbTraceJourneys({
          drawn,
          departure,
          modes: ALL_MODES,
          lines: network.lines,
        });
        if (requestId !== inferenceRequest.current) return;
        setCandidates(journeys);
        setRouteNotice(
          "This is a likely schedule-valid route, not proof. Pick another option if it better matches your memory."
        );
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : "VBB returned an unknown error.";
        const fallback = inferJourney(drawn, network.lines);
        if (requestId !== inferenceRequest.current) return;
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
      if (requestId !== inferenceRequest.current) return;
      setRouteNotice(
        error instanceof Error
          ? error.message
          : "The transit data needed for route inference could not be loaded."
      );
    } finally {
      if (requestId === inferenceRequest.current) setInferenceBusy(false);
    }
  };

  const selectedItinerary = itinerary.length > 0 && (
    <div className="lf-selected-itinerary" aria-label="Added to your day">
      {itinerary.map((entry) => (
        <span key={entry.uid}>
          <strong>{entry.label}</strong>
          <button type="button" onClick={() => onRemove(entry.uid)} aria-label={`Remove ${entry.label}`}>×</button>
        </span>
      ))}
    </div>
  );

  if (view === "search") {
    return (
      <div className="lf-search-panel">
        <label className="lf-search-input">
          <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="7" />
            <path d="m16.5 16.5 4.5 4.5" />
          </svg>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="U8, Alexanderplatz, museum…"
            aria-label="Search a Berlin line, station or place"
          />
        </label>

        {selectedItinerary}

        {sourceError && (
          <div className="lf-tool-alert" role="alert">
            <span>{sourceError}</span>
            <button type="button" onClick={onRetrySources}>Retry</button>
          </div>
        )}
        {loading && <p className="lf-tool-note">Loading Berlin lines and places…</p>}

        {!query && index && (
          <>
            <span className="lf-section-label">Lines</span>
            <div className="lf-quick-lines">
              {index.quickLines.map((item) => {
                const added = addedRefs.has(item.refId);
                return (
                  <button
                    key={item.refId}
                    type="button"
                    className={added ? "is-added" : undefined}
                    style={{ backgroundColor: item.color || "#57534e" }}
                    onClick={() => toggle(item)}
                  >
                    {item.label}{added ? " ✓" : ""}
                  </button>
                );
              })}
            </div>
            {index.quickVenues.length > 0 && (
              <>
                <span className="lf-section-label">Places</span>
                <div className="lf-search-results">
                  {index.quickVenues.map((item) => (
                    <ItemRow
                      key={item.refId}
                      item={item}
                      added={addedRefs.has(item.refId)}
                      onToggle={() => toggle(item)}
                    />
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {query && !sourceError && (
          <>
            <span className="lf-section-label">Results</span>
            <div className="lf-search-results">
              {results.length ? (
                results.map((item) => (
                  <ItemRow
                    key={`${item.kind}-${item.refId}`}
                    item={item}
                    added={addedRefs.has(item.refId)}
                    onToggle={() => toggle(item)}
                  />
                ))
              ) : (
                !loading && <p className="lf-tool-note">No lines or places match “{query}”.</p>
              )}
            </div>
          </>
        )}
      </div>
    );
  }

  if (view === "photos") {
    return (
      <div className="lf-photos-panel">
        <span className="lf-section-label">Step 2 of 3 · Rebuild your day</span>
        <h1>Choose the dates you were travelling</h1>
        <p className="lf-photo-privacy">
          If you do not know the exact loss day, choose the start and end of your trip. We read photo times and coordinates only inside that window, then show each possible day separately.
        </p>

        <div className="lf-photo-import">
          <span className="lf-photo-window-label">{item.dateCertainty === "range" ? "TRIP RANGE" : "ONE DAY"}</span>
          <strong>{currentWindowLabel}</strong>
          <button type="button" disabled={photoBusy || !index} onClick={() => setDatePickerOpen(true)} className="lf-primary">
            {photoBusy
              ? photoProgress
                ? `Reading ${photoProgress.done}/${photoProgress.total}…`
                : "Reading on your device…"
              : photoDays.length
                ? "Change dates & read again"
                : "Choose dates & read photos"}
          </button>
          <input
            ref={webPhotoInput}
            className="lf-hidden-photo-input"
            type="file"
            accept="image/*"
            multiple
            disabled={photoBusy || !index}
            onChange={(event) => handlePhotos(event.currentTarget)}
          />
          <small>
            {nativePhotos
              ? "Photos stay on this iPhone; PhotoKit filters the dates before metadata is read. No image is uploaded."
              : "After choosing dates, select the matching photos. We discard photos outside the window from their local EXIF metadata. No image is uploaded."}
          </small>
        </div>

        {photoMsg && <p className="lf-photo-message" role="status">{photoMsg}</p>}

        {photoDays.length > 1 && (
          <div className="lf-photo-days">
            <span className="lf-section-label">Possible days · review one at a time</span>
            <div role="group" aria-label="Choose a possible day to review">
              {photoDays.map((group) => {
                const key = dayKeyOf(group);
                const selected = key === selectedDayKey;
                return (
                  <button key={key} type="button" className={selected ? "is-active" : undefined} disabled={photoBusy} onClick={() => applyPhotoDay(group)}>
                    {group.day ? formatBerlinDay(group.day) : "No date"} <small>{group.count}</small>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {anchors.length >= 2 && (
          <div className="lf-photo-map">
            <DayReplay anchors={anchors} dayKey={selectedDayKey && selectedDayKey !== "unknown" ? selectedDayKey : null} />
          </div>
        )}

        {(anchors.length > 0 || routeNotice || photoBusy) && (
          <div className="lf-inference-card">
            <JourneyInference
              anchors={anchors}
              busy={photoBusy || inferenceBusy}
              busyMessage={photoBusy ? "Reading photo locations and capture times on this device." : "Comparing the possible route with Berlin’s timetable."}
              candidates={candidates}
              selectedIndex={selectedCandidate}
              offlinePlan={offlinePlan}
              addedRefs={addedRefs}
              notice={routeNotice}
              used={inferredUsed}
              onSelect={setSelectedCandidate}
              onUse={useInferredItinerary}
              onAddLine={addLineById}
            />
          </div>
        )}

        {datePickerOpen && (
          <DateWindowPicker
            item={item}
            busy={photoBusy}
            onCancel={() => setDatePickerOpen(false)}
            onConfirm={confirmPhotoWindow}
          />
        )}
      </div>
    );
  }

  return null;
}
