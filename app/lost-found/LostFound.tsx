"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchSources, type SearchItem, type SourceIndex } from "./data";
import { resolveParties, type ResolvedParty } from "./parties";
import { blockerForStep } from "./progress";
import { buildReportDrafts } from "./report";
import { buildAutofillPackage } from "./autofill";
import { clearCase, loadCase, loadContact, saveCase, saveContact } from "./storage";
import {
  nextSubmissionRecord,
  submissionFingerprint,
} from "./submission";
import {
  emptyCase,
  ITEM_CATEGORY_META,
  lossDateWindow,
  type Contact,
  type ItineraryEntry,
  type LostCase,
  type LostItem,
  type ReportState,
  type SubmissionRecord,
} from "./types";
import StepItem from "./steps/StepItem";
import StepRetrace from "./steps/StepRetrace";
import RouteMap from "./RouteMap";
import type { RoutePreview } from "./routePreview";

type Screen =
  | "launch"
  | "describe"
  | "retrace"
  | "offices"
  | "report"
  | "case"
  | "tracking"
  | "settings";

type RetraceView = "map" | "search" | "photos";
type BrandIntroPhase = "waiting" | "returning" | "leaving" | "done";
type DataRefreshFeedback = {
  tone: "checking" | "success" | "warning" | "error";
  title: string;
  detail: string;
};

const TAB_ICONS = {
  case: "M4.5 7.5h15v12h-15z M9 7.5V5.5h6v2",
  retrace: "M9 3.5l6 2 5-2v15l-5 2-6-2-5 2v-15z M9 3.5v15M15 5.5v15",
  offices: "M5 20.5V7l7-3.5L19 7v13.5 M9.5 20.5v-6h5v6",
  tracking: "M4.5 6.5h15M4.5 12h15M4.5 17.5h9",
} as const;

function newUid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `i-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function entryFromSearch(item: SearchItem): ItineraryEntry {
  return {
    uid: newUid(),
    kind: item.kind,
    refId: item.refId,
    label: item.label,
    sublabel: item.sublabel,
    mode: item.mode,
    category: item.category,
    journeys: item.journeys?.map((journey) => ({ ...journey })),
    operators: item.operators?.map((operator) => ({ ...operator })),
    officialWebsite: item.officialWebsite,
    officialPhone: item.officialPhone,
    officialEmail: item.officialEmail,
    lostFoundUrl: item.lostFoundUrl,
    contactSourceUrl: item.contactSourceUrl,
    officialWebsiteSourceUrl: item.officialWebsiteSourceUrl,
    contactUpdatedAt: item.contactUpdatedAt,
    lostFoundChannels: item.lostFoundChannels,
    lostFoundResponsibility: item.lostFoundResponsibility,
  };
}

function mergeJourneys(
  current: ItineraryEntry["journeys"],
  incoming: ItineraryEntry["journeys"]
): ItineraryEntry["journeys"] {
  if (!incoming?.length) return current;
  const merged = [...(current ?? [])];
  const signatures = new Set(merged.map((journey) => JSON.stringify(journey)));
  for (const journey of incoming) {
    const signature = JSON.stringify(journey);
    if (!signatures.has(signature)) {
      signatures.add(signature);
      merged.push({ ...journey });
    }
  }
  return merged;
}

function enrichSavedItinerary(
  itinerary: ItineraryEntry[],
  index: SourceIndex
): ItineraryEntry[] {
  const sources = new Map(index.items.map((item) => [item.refId, item]));
  return itinerary.map((entry) => {
    const source = sources.get(entry.refId);
    if (!source) return entry;
    return {
      ...entry,
      operators: entry.operators?.length
        ? entry.operators
        : source.operators?.map((operator) => ({ ...operator })),
      officialWebsite: entry.officialWebsite ?? source.officialWebsite,
      officialPhone: entry.officialPhone ?? source.officialPhone,
      officialEmail: entry.officialEmail ?? source.officialEmail,
      lostFoundUrl: entry.lostFoundUrl ?? source.lostFoundUrl,
      contactSourceUrl: entry.contactSourceUrl ?? source.contactSourceUrl,
      officialWebsiteSourceUrl:
        entry.officialWebsiteSourceUrl ?? source.officialWebsiteSourceUrl,
      contactUpdatedAt: entry.contactUpdatedAt ?? source.contactUpdatedAt,
      lostFoundChannels: source.lostFoundChannels,
      lostFoundResponsibility: source.lostFoundResponsibility,
    };
  });
}

function Chevron({ direction = "right" }: { direction?: "left" | "right" }) {
  return (
    <svg
      aria-hidden="true"
      width="9"
      height="15"
      viewBox="0 0 9 15"
      fill="none"
      className={direction === "right" ? "lf-chevron-right" : undefined}
    >
      <path d="M8 1L2 7.5 8 14" stroke="currentColor" strokeWidth="2" />
    </svg>
  );
}

function StatusBar() {
  return (
    <div className="lf-statusbar" aria-hidden="true">
      <span>9:41</span>
      <div className="lf-status-icons">
        <span className="lf-signal"><i /><i /><i /><i /></span>
        <svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor">
          <path d="M8.5 3.2c2.3 0 4.4.9 5.9 2.4l1.1-1.1A9.8 9.8 0 0 0 8.5 1.5a9.8 9.8 0 0 0-7 3l1.1 1.1a8.3 8.3 0 0 1 5.9-2.4Z" />
          <path d="M8.5 6.8c1.4 0 2.6.5 3.5 1.4l1.1-1.1a6.5 6.5 0 0 0-9.2 0L5 8.2a5 5 0 0 1 3.5-1.4Z" />
          <circle cx="8.5" cy="10.5" r="1.5" />
        </svg>
        <span className="lf-battery"><i /></span>
      </div>
    </div>
  );
}

function SettingsIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M18.4 5.6l-1.7 1.7M7.3 16.7l-1.7 1.7" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none">
      <path d="M19.5 8.5A8 8 0 1 0 20 15" />
      <path d="M19.5 3.5v5h-5" />
    </svg>
  );
}

function DataRefreshNotice({ feedback }: { feedback: DataRefreshFeedback }) {
  return (
    <div className={`lf-data-notice is-${feedback.tone}`} role="status" aria-live="polite">
      <span className="lf-data-notice-mark" aria-hidden="true">
        {feedback.tone === "success" ? "✓" : feedback.tone === "error" ? "!" : ""}
      </span>
      <span className="lf-data-notice-copy">
        <strong>{feedback.title}</strong>
        <small>{feedback.detail}</small>
      </span>
    </div>
  );
}

function BrandMark({
  state,
  intro = false,
}: {
  state: "detached" | "returning" | "settled";
  intro?: boolean;
}) {
  return (
    <svg
      className={`lf-brand-mark lf-brand-mark--${state}${intro ? " lf-brand-mark--intro" : ""}`}
      aria-hidden="true"
      width="24"
      height="24"
      viewBox="0 0 64 64"
      fill="none"
    >
      <path
        d="M38.4 53A22 22 0 1 1 53 38.4"
        stroke="currentColor"
        strokeWidth="8"
      />
      <path
        className="lf-brand-mark-piece"
        d="M50.5 44A22 22 0 0 1 44 50.5"
        strokeWidth="8"
      />
    </svg>
  );
}

function BottomTabs({
  screen,
  go,
}: {
  screen: Screen;
  go: (screen: Screen) => void;
}) {
  const tabs = [
    ["case", "Case"],
    ["retrace", "Route"],
    ["offices", "Offices"],
    ["tracking", "Tracking"],
  ] as const;
  return (
    <nav className="lf-tabbar" aria-label="Case navigation">
      {tabs.map(([id, label]) => (
        <button
          key={id}
          type="button"
          className={screen === id ? "is-active" : undefined}
          onClick={() => go(id)}
          aria-current={screen === id ? "page" : undefined}
        >
          <svg aria-hidden="true" width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d={TAB_ICONS[id]} />
          </svg>
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function partyKind(resolved: ResolvedParty): string {
  if (resolved.party.guidanceOnly) return "Official guidance";
  if (resolved.entries.some((entry) => entry.kind === "venue")) return "Venue";
  if (resolved.party.id === "zentral") return "City-wide";
  return "Transport operator";
}

function partyReason(resolved: ResolvedParty): string {
  return resolved.reasons[0] ?? resolved.party.nextStep ?? resolved.party.scope;
}

function titleForCase(lostCase: LostCase): string {
  const description = lostCase.item.description.trim();
  if (description) {
    const short = description.split(/[,.]/)[0].trim();
    return short.length > 34 ? `${short.slice(0, 33).trim()}…` : short;
  }
  return lostCase.item.category
    ? ITEM_CATEGORY_META[lostCase.item.category].label
    : "Lost item";
}

function lostDateLabel(date: string): string {
  const parsed = new Date(`${date}T12:00:00`);
  if (!Number.isFinite(parsed.getTime())) return date;
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(parsed);
}

function lossWindowLabel(item: LostItem): string {
  const { start, end } = lossDateWindow(item);
  return start === end
    ? lostDateLabel(start)
    : `${lostDateLabel(start)} – ${lostDateLabel(end)}`;
}

function dataSourceLabel(source: SourceIndex["dataUpdate"]["source"]): string {
  if (source === "remote") return "yulid.org";
  if (source === "cache") return "verified device cache";
  if (source === "worker") return "app service fallback";
  return "built into app";
}

export default function LostFound() {
  const [lostCase, setLostCase] = useState<LostCase>(emptyCase);
  const [screen, setScreen] = useState<Screen>("launch");
  const [settingsBack, setSettingsBack] = useState<Screen>("launch");
  const [retraceView, setRetraceView] = useState<RetraceView>("photos");
  const [sheetExpanded, setSheetExpanded] = useState(false);
  const [activePartyId, setActivePartyId] = useState<string | null>(null);
  const [reportLanguage, setReportLanguage] = useState<"en" | "de">("en");
  const [copied, setCopied] = useState(false);
  const [autofillCopied, setAutofillCopied] = useState(false);
  const [index, setIndex] = useState<SourceIndex | null>(null);
  const [loading, setLoading] = useState(true);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dataRefreshFeedback, setDataRefreshFeedback] =
    useState<DataRefreshFeedback | null>(null);
  const [routePreview, setRoutePreview] = useState<RoutePreview | null>(null);
  const [brandIntroPhase, setBrandIntroPhase] = useState<BrandIntroPhase>("waiting");
  const hydrated = useRef(false);
  const sourceRequest = useRef(0);

  const loadSources = useCallback((manual = false) => {
    const request = ++sourceRequest.current;
    setLoading(true);
    setSourceError(null);
    if (manual) {
      setDataRefreshFeedback({
        tone: "checking",
        title: "Checking for updates",
        detail: "Verifying reviewed data from yulid.org",
      });
    }
    fetchSources()
      .then((nextIndex) => {
        if (request !== sourceRequest.current) return;
        setIndex(nextIndex);
        setLostCase((current) => ({
          ...current,
          itinerary: enrichSavedItinerary(current.itinerary, nextIndex),
        }));
        if (manual) {
          const feedback =
            nextIndex.dataUpdate.source === "remote"
              ? {
                  tone: "success" as const,
                  title: "Reviewed data is up to date",
                  detail: `${nextIndex.dataUpdate.channelCount} channels · ${nextIndex.dataUpdate.reviewedVenueCount} places · yulid.org`,
                }
              : nextIndex.dataUpdate.source === "cache"
                ? {
                    tone: "warning" as const,
                    title: "Using verified offline data",
                    detail: `${nextIndex.dataUpdate.channelCount} channels · ${nextIndex.dataUpdate.reviewedVenueCount} places`,
                  }
                : nextIndex.dataUpdate.source === "worker"
                  ? {
                      tone: "warning" as const,
                      title: "Using the app service backup",
                      detail: `${nextIndex.dataUpdate.channelCount} channels · ${nextIndex.dataUpdate.reviewedVenueCount} places`,
                    }
                  : {
                      tone: "warning" as const,
                      title: "Using data built into the app",
                      detail: `${nextIndex.dataUpdate.channelCount} channels · ${nextIndex.dataUpdate.reviewedVenueCount} places`,
                    };
          setDataRefreshFeedback(feedback);
        }
      })
      .catch((error: unknown) => {
        if (request !== sourceRequest.current) return;
        setIndex(null);
        setSourceError(
          error instanceof Error
            ? error.message
            : "Berlin line and place data could not be loaded."
        );
        if (manual) {
          setDataRefreshFeedback({
            tone: "error",
            title: "Couldn’t refresh the data",
            detail: "Check your connection and try again.",
          });
        }
      })
      .finally(() => {
        if (request === sourceRequest.current) setLoading(false);
      });
  }, []);

  useEffect(() => {
    const loaded = loadCase();
    if (!loaded.contact.email.trim() && !loaded.contact.phone?.trim()) {
      loaded.contact = loadContact();
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLostCase(loaded);
    hydrated.current = true;
    loadSources();
    return () => {
      sourceRequest.current += 1;
    };
  }, [loadSources]);

  useEffect(() => {
    let animationFrame = 0;
    let returnTimer = 0;
    let leaveTimer = 0;
    let doneTimer = 0;

    animationFrame = window.requestAnimationFrame(() => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        setBrandIntroPhase("done");
        return;
      }
      // Hold the broken mark just long enough to be read as broken, play the
      // piece returning (620ms in CSS), then leave. The splash is over in a
      // little over a second — long enough to mean something, short enough
      // that it never sits between the traveller and the form.
      returnTimer = window.setTimeout(() => setBrandIntroPhase("returning"), 380);
      leaveTimer = window.setTimeout(() => setBrandIntroPhase("leaving"), 1120);
      doneTimer = window.setTimeout(() => setBrandIntroPhase("done"), 1380);
    });

    return () => {
      window.cancelAnimationFrame(animationFrame);
      window.clearTimeout(returnTimer);
      window.clearTimeout(leaveTimer);
      window.clearTimeout(doneTimer);
    };
  }, []);

  useEffect(() => {
    if (hydrated.current) saveCase(lostCase);
  }, [lostCase]);

  useEffect(() => {
    if (hydrated.current) saveContact(lostCase.contact);
  }, [lostCase.contact]);

  const resolved = useMemo(
    () =>
      resolveParties(
        lostCase.itinerary,
        lostCase.item.category,
        Boolean(lostCase.item.includeCentralOffice)
      ),
    [
      lostCase.item.category,
      lostCase.item.includeCentralOffice,
      lostCase.itinerary,
    ]
  );

  const activeResolved = useMemo(
    () => resolved.find((entry) => entry.party.id === activePartyId) ?? resolved[0] ?? null,
    [activePartyId, resolved]
  );
  const activeDrafts = useMemo(
    () => (activeResolved ? buildReportDrafts(lostCase, activeResolved) : null),
    [activeResolved, lostCase]
  );
  const activeAutofill = useMemo(
    () =>
      activeResolved ? buildAutofillPackage(lostCase, activeResolved) : null,
    [activeResolved, lostCase]
  );
  const completedCount = resolved.filter((entry) => {
    const state = lostCase.reported[entry.party.id] ?? "todo";
    return state === "sent" || state === "replied";
  }).length;
  const caseTitle = titleForCase(lostCase);
  const caseId = `B-${lostCase.updatedAt.replace(/\D/g, "").slice(-4).padStart(4, "0")}`;

  const updateItem = (patch: Partial<LostItem>) => {
    setMessage(null);
    setLostCase((current) => ({ ...current, item: { ...current.item, ...patch } }));
  };
  const updateContact = (patch: Partial<Contact>) =>
    setLostCase((current) => ({
      ...current,
      contact: { ...current.contact, ...patch },
    }));
  const addItinerary = (item: SearchItem) => {
    setMessage(null);
    setLostCase((current) => {
      const existingIndex = current.itinerary.findIndex((entry) => entry.refId === item.refId);
      if (existingIndex < 0) {
        return { ...current, itinerary: [...current.itinerary, entryFromSearch(item)] };
      }
      if (!item.journeys?.length && !item.operators?.length) return current;
      const itinerary = [...current.itinerary];
      const existing = itinerary[existingIndex];
      const operators = [...(existing.operators ?? [])];
      const operatorIds = new Set(operators.map((operator) => operator.id));
      for (const operator of item.operators ?? []) {
        if (!operatorIds.has(operator.id)) {
          operatorIds.add(operator.id);
          operators.push({ ...operator });
        }
      }
      itinerary[existingIndex] = {
        ...existing,
        journeys: mergeJourneys(existing.journeys, item.journeys),
        operators: operators.length ? operators : undefined,
      };
      return { ...current, itinerary };
    });
  };
  const removeItinerary = (uid: string) =>
    setLostCase((current) => ({
      ...current,
      itinerary: current.itinerary.filter((entry) => entry.uid !== uid),
    }));
  const setReportState = (partyId: string, state: ReportState) =>
    setLostCase((current) => ({
      ...current,
      reported: { ...current.reported, [partyId]: state },
    }));
  const setSubmission = (record: SubmissionRecord) =>
    setLostCase((current) => {
      const previous = current.submissions[record.partyId] ?? [];
      return {
        ...current,
        submissions: {
          ...current.submissions,
          [record.partyId]: [
            record,
            ...previous.filter((candidate) => candidate.fingerprint !== record.fingerprint),
          ]
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .slice(0, 20),
        },
      };
    });

  const reset = () => {
    if (
      typeof window !== "undefined" &&
      !window.confirm("Delete this case from this device? Your contact details will be kept.")
    ) {
      return;
    }
    clearCase();
    const fresh = emptyCase();
    fresh.contact = loadContact();
    setLostCase(fresh);
    setActivePartyId(null);
    setRoutePreview(null);
    setRetraceView("photos");
    setScreen("launch");
    setMessage(null);
  };

  const go = (target: Screen, preferredRetraceView?: RetraceView) => {
    const targetStep =
      target === "retrace" ? 1 : ["offices", "report", "case", "tracking"].includes(target) ? 2 : 0;
    const blocker = blockerForStep(targetStep, lostCase);
    if (blocker) {
      setScreen(blocker.step === 0 ? "describe" : "retrace");
      setRetraceView(lostCase.itinerary.length ? "map" : "photos");
      setMessage(blocker.message);
      return;
    }
    setMessage(null);
    if (target === "settings") {
      setSettingsBack(screen);
    }
    if (target === "retrace") {
      setRetraceView(
        preferredRetraceView ?? (lostCase.itinerary.length ? "map" : "photos")
      );
    }
    setScreen(target);
  };

  const openReport = (partyId: string) => {
    setActivePartyId(partyId);
    setReportLanguage("en");
    setAutofillCopied(false);
    setScreen("report");
  };

  const recordActiveSubmission = (status: SubmissionRecord["status"]) => {
    if (!activeResolved) return;
    setSubmission(
      nextSubmissionRecord({
        partyId: activeResolved.party.id,
        fingerprint: submissionFingerprint(lostCase, activeResolved),
        status,
      })
    );
  };

  const markActiveSent = () => {
    if (!activeResolved) return;
    setReportState(activeResolved.party.id, "sent");
    recordActiveSubmission("user_confirmed");
    setScreen("tracking");
  };

  const copyDraft = async () => {
    if (!activeDrafts) return;
    try {
      await navigator.clipboard.writeText(activeDrafts[reportLanguage]);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const copyAutofillPackage = async () => {
    if (!activeAutofill) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(activeAutofill));
      setAutofillCopied(true);
      window.setTimeout(() => setAutofillCopied(false), 1600);
    } catch {
      setAutofillCopied(false);
    }
  };

  const renderTopBar = (backLabel: string, onBack: () => void, title: string) => (
    <div className="lf-topbar">
      <button type="button" onClick={onBack} className="lf-back">
        <Chevron direction="left" />
        <span>{backLabel}</span>
      </button>
      <strong>{title}</strong>
      <span className="lf-topbar-spacer" />
    </div>
  );

  return (
    <main className="lf-stage">
      <div className="lf-device">
        <div className="lf-dynamic-island" aria-hidden="true" />
        <StatusBar />

        {brandIntroPhase !== "done" && (
          <div
            className={`lf-brand-intro${brandIntroPhase === "leaving" ? " is-leaving" : ""}`}
            aria-hidden="true"
          >
            <BrandMark
              intro
              state={brandIntroPhase === "waiting" ? "detached" : "returning"}
            />
          </div>
        )}

        {screen === "launch" && (
          <section className="lf-screen lf-launch">
            <div className="lf-scroll lf-launch-body">
              <header className="lf-brand-row">
                <div className="lf-brand">
                  <BrandMark state="settled" />
                  <strong>Berlin Lost &amp; Found</strong>
                </div>
                <div className="lf-launch-tools">
                  <button
                    type="button"
                    className={`lf-icon-button${loading ? " is-loading" : ""}`}
                    onClick={() => loadSources(true)}
                    disabled={loading}
                    aria-label="Refresh reviewed data"
                  >
                    <RefreshIcon />
                  </button>
                  <button type="button" className="lf-icon-button" onClick={() => go("settings")} aria-label="Open settings">
                    <SettingsIcon />
                  </button>
                </div>
              </header>
              <h1>Lost something in Berlin?</h1>
              <p className="lf-lede">
                We work out which lost-property offices are responsible, and prepare each report for you.
              </p>
              {dataRefreshFeedback && <DataRefreshNotice feedback={dataRefreshFeedback} />}
              <p className="lf-sr-only">What did you lose? Berlin transit data is provided by VBB.</p>
              <div className="lf-launch-steps lf-stagger">
                {[
                  ["01", "Describe the item", "One line is enough."],
                  ["02", "Choose dates & read photos", "Use one day or your whole trip."],
                  ["03", "Send & track", "You submit; we keep the receipts."],
                ].map(([number, title, detail]) => (
                  <div key={number}>
                    <span>{number}</span>
                    <p><strong>{title}</strong><small>{detail}</small></p>
                  </div>
                ))}
              </div>
            </div>
            <div className="lf-bottom-action">
              <button type="button" className="lf-primary" onClick={() => go("describe")}>
                {lostCase.item.description.trim() ? "Continue this case" : "Start a case"}
              </button>
              <p>Stays on this iPhone. Nothing is sent for you. You stay in control.</p>
            </div>
          </section>
        )}

        {screen === "describe" && (
          <section className="lf-screen lf-column">
            <div className="lf-modalbar">
              <button type="button" onClick={() => setScreen("launch")}>Cancel</button>
              <span>Step 1 of 3</span>
              <i />
            </div>
            <div className="lf-scroll lf-form-scroll">
              <h1>What did you lose?</h1>
              {message && <div className="lf-alert" role="alert">{message}</div>}
              <StepItem item={lostCase.item} onItem={updateItem} />
            </div>
            <div className="lf-bottom-action lf-bottom-action--single">
              <button type="button" className="lf-primary" onClick={() => go("retrace", "photos")}>
                Continue to travel dates
              </button>
            </div>
          </section>
        )}

        {screen === "retrace" && retraceView !== "map" && (
          <section className="lf-screen lf-column lf-tool-screen">
            {renderTopBar(
              retraceView === "photos" ? (lostCase.itinerary.length ? "Route" : "Item") : "Route",
              () => {
                if (retraceView === "photos" && !lostCase.itinerary.length) {
                  setScreen("describe");
                } else {
                  setRetraceView("map");
                }
              },
              retraceView === "photos" ? "Dates & photos" : "Add to route"
            )}
            <div className="lf-scroll lf-tool-content">
              <StepRetrace
                view={retraceView}
                index={index}
                loading={loading}
                sourceError={sourceError}
                itinerary={lostCase.itinerary}
                item={lostCase.item}
                onItem={updateItem}
                onAdd={addItinerary}
                onRemove={removeItinerary}
                onRetrySources={() => loadSources(true)}
                initialRoutePreview={routePreview}
                onRoutePreview={setRoutePreview}
              />
            </div>
            {retraceView === "photos" && (
              <div className="lf-photo-flow-footer">
                <p>
                  <strong>Next: check the route</strong>
                  <span>Add any missing line, station or place by hand.</span>
                </p>
                <button type="button" className="lf-primary" onClick={() => setRetraceView("map")}>
                  {lostCase.itinerary.length
                    ? "Review route & add missing places"
                    : "Skip photos · add route manually"}
                </button>
              </div>
            )}
          </section>
        )}

        {screen === "retrace" && retraceView === "map" && (
          <section className="lf-screen lf-map-screen">
            <RouteMap
              preview={routePreview}
              index={index}
              itinerary={lostCase.itinerary}
              bottomInset={sheetExpanded ? 575 : 325}
            />
            <div className="lf-map-controls">
              <button type="button" className="lf-map-search" onClick={() => setRetraceView("search")}>
                <svg aria-hidden="true" width="17" height="17" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" /><path d="m16.5 16.5 4.5 4.5" /></svg>
                <span>Add a missing line, station or place</span>
              </button>
              <button type="button" className="lf-map-camera" onClick={() => setRetraceView("photos")} aria-label="Use photos to retrace your day">
                <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="6" width="18" height="14" /><circle cx="12" cy="13" r="3.6" /><path d="m8 6 1.6-2h4.8L16 6" /></svg>
              </button>
            </div>
            <div className={`lf-day-sheet${sheetExpanded ? " is-expanded" : ""}`}>
              <button type="button" className="lf-sheet-handle" onClick={() => setSheetExpanded((value) => !value)} aria-label={sheetExpanded ? "Collapse your day" : "Expand your day"}><i /></button>
              <div className="lf-sheet-title">
                <strong>Review your day</strong>
                <span>{lossWindowLabel(lostCase.item).toUpperCase()}</span>
              </div>
              {message && <div className="lf-sheet-message" role="alert">{message}</div>}
              <div className="lf-sheet-list lf-stagger">
                {lostCase.itinerary.map((entry) => (
                  <div className="lf-stop-row" key={entry.uid}>
                    <span className={`lf-stop-badge lf-stop-badge--${entry.kind}`}>{entry.label.slice(0, 4)}</span>
                    <p><strong>{entry.label}</strong><small>{entry.sublabel || (entry.kind === "line" ? "Berlin transit" : "Place")}</small></p>
                    <span className="lf-stop-time">{entry.journeys?.[0]?.departure?.slice(11, 16) || "—"}</span>
                    <button type="button" onClick={() => removeItinerary(entry.uid)} aria-label={`Remove ${entry.label}`}>×</button>
                  </div>
                ))}
                <button type="button" className="lf-add-stop" onClick={() => setRetraceView("search")}>
                  <span>+</span> Add a missing line or place
                </button>
              </div>
              <div className="lf-sheet-footer">
                <button type="button" className="lf-primary" onClick={() => go("offices")}>
                  Find responsible offices <small>{lostCase.itinerary.length} stops</small>
                </button>
              </div>
            </div>
          </section>
        )}

        {screen === "offices" && (
          <section className="lf-screen lf-column lf-soft-screen">
            {renderTopBar("Route", () => go("retrace", "map"), "Offices")}
            <div className="lf-scroll lf-screen-content">
              <h1>{resolved.length} {resolved.length === 1 ? "office is" : "offices are"} responsible</h1>
              <p className="lf-muted">Each gets its own report. Send them one by one.</p>
              <div className="lf-stagger">
                {resolved.map((entry) => {
                  const state = lostCase.reported[entry.party.id] ?? "todo";
                  return (
                    <button type="button" className="lf-office-card" key={entry.party.id} onClick={() => openReport(entry.party.id)}>
                      <span className="lf-kicker">{partyKind(entry)}</span>
                      <span className={`lf-status lf-status--${state}`}>{state === "todo" ? "TO DO" : state.toUpperCase()}</span>
                      <strong>{entry.party.name}</strong>
                      <small>{entry.party.scope}</small>
                      <span className="lf-office-reason">{partyReason(entry)} <Chevron direction="right" /></span>
                    </button>
                  );
                })}
              </div>
              {resolved.length === 0 && (
                <div className="lf-empty">Add at least one line or place to find the responsible office.</div>
              )}
            </div>
            <BottomTabs screen={screen} go={go} />
          </section>
        )}

        {screen === "report" && activeResolved && activeDrafts && (
          <section className="lf-screen lf-column lf-soft-screen">
            {renderTopBar("Offices", () => setScreen("offices"), "Report")}
            <div className="lf-scroll lf-report-content">
              <span className="lf-section-label">Recipient</span>
              <h1>{activeResolved.party.name}</h1>
              <p className="lf-muted">{activeResolved.party.scope}</p>
              <div className="lf-segmented" role="group" aria-label="Report language">
                <button type="button" className={reportLanguage === "en" ? "is-active" : undefined} onClick={() => setReportLanguage("en")}>English</button>
                <button type="button" className={reportLanguage === "de" ? "is-active" : undefined} onClick={() => setReportLanguage("de")}>Deutsch</button>
              </div>
              {(!lostCase.contact.email.trim() && !lostCase.contact.phone?.trim()) && (
                <div className="lf-contact-prompt">
                  <strong>Where should the office reply?</strong>
                  <input type="email" value={lostCase.contact.email} onChange={(event) => updateContact({ email: event.target.value })} placeholder="Email address" aria-label="Reply email" />
                  <input value={lostCase.contact.phone ?? ""} onChange={(event) => updateContact({ phone: event.target.value })} placeholder="Phone (optional)" aria-label="Reply phone" />
                </div>
              )}
              <div className="lf-report-draft">
                <button type="button" onClick={copyDraft} className={copied ? "is-copied" : undefined}>{copied ? "✓ Copied" : "Copy"}</button>
                <pre>{activeDrafts[reportLanguage]}</pre>
              </div>
              <div className="lf-facts">
                <div><span>Item</span><strong>{caseTitle}</strong></div>
                <div>
                  <span>{lostCase.item.dateCertainty === "range" ? "Possible dates" : "Lost on"}</span>
                  <strong>{lossWindowLabel(lostCase.item)}</strong>
                </div>
                <div><span>Reply to</span><strong>{lostCase.contact.email || lostCase.contact.phone || "Add above"}</strong></div>
              </div>
              {activeAutofill && (
                <div className="lf-autofill-card">
                  <div>
                    <strong>Automatic form filling available</strong>
                    <small>
                      Copy this package into the desktop form helper. Consent,
                      security checks and final submission stay manual.
                    </small>
                  </div>
                  <button type="button" onClick={copyAutofillPackage}>
                    {autofillCopied ? "✓ Package copied" : "Copy autofill package"}
                  </button>
                </div>
              )}
              <p className="lf-verified">✓ Destination checked against the operator&apos;s official page. We never submit for you.</p>
            </div>
            <div className="lf-report-actions">
              <a
                href={activeResolved.party.formUrl || activeResolved.party.website}
                target="_blank"
                rel="noopener noreferrer"
                className="lf-primary"
                onClick={() => recordActiveSubmission("opened")}
              >
                {activeResolved.party.formLabel || "Open official form"} <span>↗</span>
              </a>
              <button type="button" className="lf-secondary" onClick={markActiveSent}>
                {(lostCase.reported[activeResolved.party.id] ?? "todo") === "sent" ? "Sent · confirm again" : "Mark as sent"}
              </button>
            </div>
          </section>
        )}

        {screen === "case" && (
          <section className="lf-screen lf-column lf-soft-screen">
            <div className="lf-case-header">
              <div><span>CASE {caseId}</span><button type="button" className="lf-icon-button" onClick={() => go("settings")} aria-label="Open settings"><SettingsIcon /></button></div>
              <h1>{caseTitle}</h1>
              <p>{lostCase.item.dateCertainty === "range" ? "Possible loss" : "Lost"} {lossWindowLabel(lostCase.item)} · {lostCase.itinerary.length} stops · {resolved.length} offices</p>
              <div className="lf-progress">{[0, 1, 2, 3].map((part) => <i key={part} className={part < 3 || completedCount === resolved.length ? "is-done" : undefined} />)}</div>
              <small>{completedCount} of {resolved.length} reports sent</small>
            </div>
            <div className="lf-scroll lf-screen-content">
              <div className="lf-next-card">
                <span>NEXT</span>
                <strong>{completedCount >= resolved.length && resolved.length ? "Wait for replies" : `Send ${Math.max(0, resolved.length - completedCount)} more reports`}</strong>
                <p>{completedCount >= resolved.length && resolved.length ? "Offices usually answer within a few working days." : "Each office needs its own report. Continue with the next destination."}</p>
                <button type="button" onClick={() => go(completedCount >= resolved.length && resolved.length ? "tracking" : "offices")}>{completedCount >= resolved.length && resolved.length ? "Open tracking" : "Continue"}</button>
              </div>
              <div className="lf-case-links lf-stagger">
                <button type="button" onClick={() => go("describe")}><span><strong>Item details</strong><small>{caseTitle}</small></span><Chevron direction="right" /></button>
                <button type="button" onClick={() => go("retrace")}><span><strong>Route of the day</strong><small>{lostCase.itinerary.map((entry) => entry.label).join(" · ") || "Not added"}</small></span><Chevron direction="right" /></button>
                <button type="button" onClick={() => go("offices")}><span><strong>Reports</strong><small>{completedCount} of {resolved.length} sent</small></span><Chevron direction="right" /></button>
              </div>
              <span className="lf-section-label lf-activity-label">Activity</span>
              <p className="lf-activity">{completedCount ? `${completedCount} report${completedCount === 1 ? "" : "s"} marked as sent\n` : ""}{resolved.length} offices resolved from your route{"\n"}Case stored on this device</p>
            </div>
            <BottomTabs screen={screen} go={go} />
          </section>
        )}

        {screen === "tracking" && (
          <section className="lf-screen lf-column lf-soft-screen">
            <div className="lf-tracking-header">
              <div><h1>Tracking</h1><span>CASE {caseId}</span></div>
              <div className="lf-segmented"><button type="button" className="is-active">All <small>{resolved.length}</small></button><button type="button">Sent <small>{completedCount}</small></button><button type="button">Replied <small>{resolved.filter((entry) => lostCase.reported[entry.party.id] === "replied").length}</small></button></div>
            </div>
            <div className="lf-scroll lf-tracking-list lf-stagger">
              {resolved.map((entry) => {
                const state = lostCase.reported[entry.party.id] ?? "todo";
                const submission = lostCase.submissions[entry.party.id]?.[0];
                return (
                  <button type="button" key={entry.party.id} onClick={() => openReport(entry.party.id)}>
                    <i className={`lf-state-dot lf-state-dot--${state}`} />
                    <strong>{entry.party.name}</strong>
                    <span className={`lf-status-text lf-status-text--${state}`}>{state === "todo" ? "TO DO" : state.toUpperCase()}</span>
                    <small>{submission ? `${new Date(submission.updatedAt).toLocaleDateString("en-GB")} · ${submission.status.replaceAll("_", " ")}` : "Not opened yet"}</small>
                  </button>
                );
              })}
            </div>
            <BottomTabs screen={screen} go={go} />
          </section>
        )}

        {screen === "settings" && (
          <section className="lf-screen lf-column lf-soft-screen">
            {renderTopBar("Back", () => setScreen(settingsBack), "Settings")}
            <div className="lf-scroll lf-settings-content">
              <span className="lf-section-label">Your details</span>
              <div className="lf-settings-list lf-settings-fields">
                <label><span>Name</span><input value={lostCase.contact.name} onChange={(event) => updateContact({ name: event.target.value })} placeholder="Your name" /></label>
                <label><span>Email</span><input type="email" value={lostCase.contact.email} onChange={(event) => updateContact({ email: event.target.value })} placeholder="name@example.com" /></label>
                <label><span>Phone</span><input value={lostCase.contact.phone ?? ""} onChange={(event) => updateContact({ phone: event.target.value })} placeholder="+49 …" /></label>
              </div>
              <span className="lf-section-label">Privacy</span>
              <div className="lf-settings-list">
                <div><strong>Photos stay on device</strong><small>Only capture time and coordinates are read.</small></div>
                <div><strong>Nothing is submitted for you</strong><small>You open every official form yourself.</small></div>
                <div><strong>Case stored locally</strong><small>Deleting the app deletes the case.</small></div>
              </div>
              <span className="lf-section-label">Data sources</span>
              <div className="lf-settings-list lf-source-list">
                <div><span>Lines &amp; stops</span><small>VBB GTFS · CC BY 4.0</small></div>
                <div><span>Places</span><small>OpenStreetMap · ODbL</small></div>
                <div>
                  <span>Lost-property channels</span>
                  <small>
                    {index
                      ? `${index.dataUpdate.channelCount} channels · ${index.dataUpdate.reviewedVenueCount} reviewed places · ${dataSourceLabel(index.dataUpdate.source)}`
                      : "Built-in snapshot"}
                  </small>
                </div>
              </div>
              <button
                type="button"
                className={`lf-refresh-data${loading ? " is-loading" : ""}`}
                onClick={() => loadSources(true)}
                disabled={loading}
              >
                <span className="lf-refresh-data-icon" aria-hidden="true"><RefreshIcon /></span>
                <span className="lf-refresh-data-copy">
                  <strong>{loading ? "Checking for updates" : "Refresh reviewed data"}</strong>
                  <small>{loading ? "Verifying source and integrity" : "Check yulid.org for verified changes"}</small>
                </span>
              </button>
              {dataRefreshFeedback && <DataRefreshNotice feedback={dataRefreshFeedback} />}
              {index?.dataUpdate.warning && (
                <p className="lf-data-warning">{index.dataUpdate.warning}</p>
              )}
              <button type="button" className="lf-delete" onClick={reset}>Delete case data</button>
            </div>
          </section>
        )}

        <div className="lf-home-indicator" aria-hidden="true"><i /></div>
      </div>
    </main>
  );
}
