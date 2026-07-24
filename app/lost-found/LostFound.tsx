"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchSources, type SearchItem, type SourceIndex } from "./data";
import { resolveParties } from "./parties";
import { clearCase, loadCase, loadContact, saveCase, saveContact } from "./storage";
import {
  emptyCase,
  type Contact,
  type ItineraryEntry,
  type LostCase,
  type LostItem,
    type ReportState,
    type SubmissionRecord,
} from "./types";
import { GhostButton, PrimaryButton, cx } from "./ui";
import StepItem from "./steps/StepItem";
import StepParties from "./steps/StepParties";
import StepReport from "./steps/StepReport";
import StepRetrace from "./steps/StepRetrace";
import { blockerForStep } from "./progress";

const STEPS = [
  {
    n: "01",
    tab: "Describe",
    heading: "What did you lose?",
    sub: "A short, recognisable description is enough to start.",
  },
  {
    n: "02",
    tab: "Rebuild",
    heading: "Where might you have lost it?",
    sub: "Add the places and transport lines you remember.",
  },
  {
    n: "03",
    tab: "Check",
    heading: "Check the destinations",
    sub: "We group your route into the offices and venues that may have your item.",
  },
  {
    n: "04",
    tab: "Send & track",
    heading: "Send and track your reports",
    sub: "Review each prepared report, submit it on the official channel, then save the result.",
  },
] as const;

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
    };
  });
}

export default function LostFound() {
  const [lostCase, setLostCase] = useState<LostCase>(emptyCase);
  const [step, setStep] = useState(0);
  const [index, setIndex] = useState<SourceIndex | null>(null);
  const [loading, setLoading] = useState(true);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [stepMessage, setStepMessage] = useState<string | null>(null);
  const hydrated = useRef(false);

  const loadSources = useCallback(() => {
    let active = true;
    setLoading(true);
    setSourceError(null);
    fetchSources()
      .then((nextIndex) => {
        if (active) {
          setIndex(nextIndex);
          setLostCase((current) => ({
            ...current,
            itinerary: enrichSavedItinerary(current.itinerary, nextIndex),
          }));
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        setIndex(null);
        setSourceError(
          error instanceof Error
            ? error.message
            : "Berlin line and attraction data could not be loaded."
        );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // Load saved case + Berlin sources on mount. We hydrate from localStorage in
  // an effect (not a lazy initializer) so SSR and the first client render match;
  // the synchronous setState here is intentional and hydration-safe.
  useEffect(() => {
    const loaded = loadCase();
    // Pull the remembered contact into a fresh case so returning users skip it.
    if (!loaded.contact.email.trim() && !loaded.contact.phone?.trim()) {
      loaded.contact = loadContact();
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLostCase(loaded);
    hydrated.current = true;
    return loadSources();
  }, [loadSources]);

  // Persist after hydration.
  useEffect(() => {
    if (hydrated.current) saveCase(lostCase);
  }, [lostCase]);

  // Remember the contact separately so it survives new cases / resets.
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

  const updateItem = (patch: Partial<LostItem>) => {
    setStepMessage(null);
    setLostCase((c) => ({ ...c, item: { ...c.item, ...patch } }));
  };
  const updateContact = (patch: Partial<Contact>) =>
    setLostCase((c) => ({ ...c, contact: { ...c.contact, ...patch } }));
  const addItinerary = (item: SearchItem) => {
    setStepMessage(null);
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
    setLostCase((c) => ({ ...c, itinerary: c.itinerary.filter((e) => e.uid !== uid) }));
  const setReportState = (partyId: string, state: ReportState) =>
    setLostCase((c) => ({ ...c, reported: { ...c.reported, [partyId]: state } }));
  const setSubmission = (record: SubmissionRecord) =>
    setLostCase((current) => {
      const previous = current.submissions[record.partyId] ?? [];
      const history = [
        record,
        ...previous.filter(
          (candidate) => candidate.fingerprint !== record.fingerprint
        ),
      ]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, 20);
      return {
        ...current,
        submissions: {
          ...current.submissions,
          [record.partyId]: history,
        },
      };
    });

  const reset = () => {
    if (typeof window !== "undefined" && !window.confirm("Clear the current item and itinerary? Your contact details are kept.")) return;
    clearCase();
    const fresh = emptyCase();
    fresh.contact = loadContact();
    setLostCase(fresh);
    setStep(0);
    setStepMessage(null);
  };

  const meta = STEPS[step];
  const canForward = step < STEPS.length - 1;
  const goToStep = (target: number) => {
    const blocker = blockerForStep(target, lostCase);
    if (blocker) {
      setStep(blocker.step);
      setStepMessage(blocker.message);
      return;
    }
    setStep(Math.max(0, Math.min(STEPS.length - 1, target)));
    setStepMessage(null);
  };

  return (
    <main className="min-h-screen bg-gradient-to-b from-orange-50/60 via-stone-50 to-stone-100 dark:from-stone-950 dark:via-stone-950 dark:to-black">
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-4 py-6 sm:px-6">
        {/* Header */}
        <header className="mb-5 flex items-start gap-3 sm:items-center">
          <span className="brand-mark" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-bold tracking-tight text-stone-900 dark:text-stone-50">
              Berlin <span className="text-orange-600">Lost &amp; Found</span>
            </h1>
            <p className="max-w-md text-xs leading-relaxed text-stone-500 dark:text-stone-400">
              Find the right offices, prepare each report and track what happens next
            </p>
          </div>
          <button
            type="button"
            onClick={reset}
            className="flex-none rounded-lg px-2.5 py-1.5 text-xs text-stone-400 transition hover:bg-stone-100 hover:text-stone-600 dark:hover:bg-stone-800"
          >
            Start over
          </button>
        </header>

        {/* Step tabs */}
        <nav className="mb-5 flex items-center gap-1.5" aria-label="Report progress">
          {STEPS.map((s, i) => {
            const done = i < step;
            const active = i === step;
            return (
              <button
                key={s.n}
                type="button"
                onClick={() => goToStep(i)}
                aria-label={`Step ${i + 1}: ${s.tab}`}
                aria-current={active ? "step" : undefined}
                className={cx(
                  "flex flex-1 items-center gap-2 rounded-xl px-2.5 py-2 text-left transition",
                  active
                    ? "bg-white shadow-sm ring-1 ring-orange-200 dark:bg-stone-900 dark:ring-orange-500/30"
                    : "hover:bg-white/60 dark:hover:bg-stone-900/60"
                )}
              >
                <span
                  className={cx(
                    "flex h-6 w-6 flex-none items-center justify-center rounded-full text-[11px] font-bold",
                    active
                      ? "bg-orange-600 text-white"
                      : done
                        ? "bg-orange-100 text-orange-700 dark:bg-orange-500/15 dark:text-orange-300"
                        : "bg-stone-200 text-stone-500 dark:bg-stone-800 dark:text-stone-500"
                  )}
                >
                  {done ? "✓" : i + 1}
                </span>
                <span
                  className={cx(
                    "hidden text-xs font-semibold sm:block",
                    active ? "text-stone-900 dark:text-stone-100" : "text-stone-500"
                  )}
                >
                  {s.tab}
                </span>
              </button>
            );
          })}
        </nav>

        {/* Content */}
        <section className="flex-1">
          {step === 0 && (
            <div className="mb-5 rounded-2xl border border-orange-200 bg-white/80 p-4 shadow-sm dark:border-orange-500/30 dark:bg-stone-900/80">
              <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                We prepare the route and reports. You stay in control.
              </p>
              <p className="mt-1 text-xs leading-relaxed text-stone-500 dark:text-stone-400">
                This takes about 5–10 minutes. Your case stays in this browser.
                Nothing is submitted automatically: you review every report and
                send it through the official service.
              </p>
            </div>
          )}
          <div className="mb-4">
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-orange-600 dark:text-orange-400">
              Step {step + 1} of {STEPS.length} · {meta.tab}
            </p>
            <h2 className="text-xl font-bold tracking-tight text-stone-900 dark:text-stone-50">
              {meta.heading}
            </h2>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{meta.sub}</p>
          </div>

          {stepMessage && (
            <div
              role="alert"
              className="mb-4 rounded-xl border border-amber-300 bg-amber-50 px-3.5 py-3 text-sm text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-200"
            >
              {stepMessage}
            </div>
          )}

          {step === 0 && <StepItem item={lostCase.item} onItem={updateItem} />}
          {step === 1 && (
            <StepRetrace
              index={index}
              loading={loading}
              sourceError={sourceError}
              itinerary={lostCase.itinerary}
              lostDate={lostCase.item.lostDate}
              timeFrom={lostCase.item.timeFrom}
              onAdd={addItinerary}
              onRemove={removeItinerary}
              onRetrySources={loadSources}
            />
          )}
          {step === 2 && <StepParties resolved={resolved} />}
          {step === 3 && (
            <StepReport
              lostCase={lostCase}
              resolved={resolved}
              onSetState={setReportState}
              onContact={updateContact}
              onSubmission={setSubmission}
            />
          )}
        </section>

        {/* Nav */}
        <footer className="sticky bottom-0 z-20 mt-6 flex items-center justify-between gap-3 border-t border-stone-200/70 bg-stone-100/95 py-4 backdrop-blur dark:border-stone-800 dark:bg-black/95">
          <GhostButton onClick={() => goToStep(step - 1)} disabled={step === 0}>
            ← Back
          </GhostButton>
          <div className="flex items-center gap-3">
            {step === 1 && (
              <span className="text-xs text-stone-400">
                {lostCase.itinerary.length} added
              </span>
            )}
            {canForward ? (
              <PrimaryButton onClick={() => goToStep(step + 1)}>
                {step === 0
                  ? "Rebuild my day →"
                  : step === 1
                    ? "Find destinations →"
                    : "Prepare reports →"}
              </PrimaryButton>
            ) : (
              <span className="text-xs text-stone-400">{resolved.length} to contact</span>
            )}
          </div>
        </footer>

        <p className="pb-2 pt-1 text-center text-[11px] leading-relaxed text-stone-400">
          Lost-property details last checked against official sources on 23 July 2026. Transit and
          stop data from{" "}
          <a
            href="https://unternehmen.vbb.de/digitale-services/datensaetze/"
            className="underline underline-offset-2"
          >
            VBB GTFS (CC BY 4.0)
          </a>
          . Attractions from{" "}
          <a
            href="https://www.openstreetmap.org/copyright"
            className="underline underline-offset-2"
          >
            © OpenStreetMap contributors
          </a>{" "}
          under the{" "}
          <a
            href="https://opendatacommons.org/licenses/odbl/"
            className="underline underline-offset-2"
          >
            ODbL
          </a>
          .
        </p>
      </div>
    </main>
  );
}
