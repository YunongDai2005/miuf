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
} from "./types";
import { GhostButton, PrimaryButton, cx } from "./ui";
import StepItem from "./steps/StepItem";
import StepParties from "./steps/StepParties";
import StepReport from "./steps/StepReport";
import StepRetrace from "./steps/StepRetrace";

const STEPS = [
  { n: "01", tab: "Item", heading: "What did you lose?", sub: "Just describe it — everything else can wait." },
  { n: "02", tab: "Retrace", heading: "Where did you go today?", sub: "Tick the lines you rode and the places you visited." },
  { n: "03", tab: "Contacts", heading: "Who to contact", sub: "The operator or venue contact for each leg — and why." },
  { n: "04", tab: "Report", heading: "Send the report", sub: "Leave one contact detail, then send or copy the German / English report." },
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
    };
  });
}

export default function LostFound() {
  const [lostCase, setLostCase] = useState<LostCase>(emptyCase);
  const [step, setStep] = useState(0);
  const [index, setIndex] = useState<SourceIndex | null>(null);
  const [loading, setLoading] = useState(true);
  const [sourceError, setSourceError] = useState<string | null>(null);
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
    () => resolveParties(lostCase.itinerary, lostCase.item.category),
    [lostCase.item.category, lostCase.itinerary]
  );

  const updateItem = (patch: Partial<LostItem>) =>
    setLostCase((c) => ({ ...c, item: { ...c.item, ...patch } }));
  const updateContact = (patch: Partial<Contact>) =>
    setLostCase((c) => ({ ...c, contact: { ...c.contact, ...patch } }));
  const addItinerary = (item: SearchItem) =>
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
  const removeItinerary = (uid: string) =>
    setLostCase((c) => ({ ...c, itinerary: c.itinerary.filter((e) => e.uid !== uid) }));
  const setReportState = (partyId: string, state: ReportState) =>
    setLostCase((c) => ({ ...c, reported: { ...c.reported, [partyId]: state } }));

  const reset = () => {
    if (typeof window !== "undefined" && !window.confirm("Clear the current item and itinerary? Your contact details are kept.")) return;
    clearCase();
    const fresh = emptyCase();
    fresh.contact = loadContact();
    setLostCase(fresh);
    setStep(0);
  };

  const meta = STEPS[step];
  const canForward = step < STEPS.length - 1;

  return (
    <main className="min-h-screen bg-gradient-to-b from-orange-50/60 via-stone-50 to-stone-100 dark:from-stone-950 dark:via-stone-950 dark:to-black">
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-4 py-6 sm:px-6">
        {/* Header */}
        <header className="mb-5 flex items-center gap-3">
          <span className="brand-mark" aria-hidden>
            <span />
            <span />
            <span />
          </span>
          <div className="flex-1">
            <h1 className="text-base font-bold tracking-tight text-stone-900 dark:text-stone-50">
              Berlin <span className="text-orange-600">Lost &amp; Found</span>
            </h1>
            <p className="text-xs text-stone-500 dark:text-stone-400">
              Retrace your day, reach the right operators and venues, file reports in a tap
            </p>
          </div>
          <button
            type="button"
            onClick={reset}
            className="rounded-lg px-2.5 py-1.5 text-xs text-stone-400 transition hover:bg-stone-100 hover:text-stone-600 dark:hover:bg-stone-800"
          >
            Start over
          </button>
        </header>

        {/* Step tabs */}
        <nav className="mb-6 flex items-center gap-1.5">
          {STEPS.map((s, i) => {
            const done = i < step;
            const active = i === step;
            return (
              <button
                key={s.n}
                type="button"
                onClick={() => setStep(i)}
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
          <div className="mb-4">
            <h2 className="text-xl font-bold tracking-tight text-stone-900 dark:text-stone-50">
              {meta.heading}
            </h2>
            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{meta.sub}</p>
          </div>

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
            />
          )}
        </section>

        {/* Nav */}
        <footer className="sticky bottom-0 mt-6 flex items-center justify-between gap-3 border-t border-stone-200/70 bg-gradient-to-t from-stone-100 to-transparent py-4 dark:border-stone-800 dark:from-black">
          <GhostButton onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0}>
            ← Back
          </GhostButton>
          <div className="flex items-center gap-3">
            {step === 1 && (
              <span className="text-xs text-stone-400">
                {lostCase.itinerary.length} added
              </span>
            )}
            {canForward ? (
              <PrimaryButton onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}>
                {step === 2 ? "Draft reports →" : "Next →"}
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
