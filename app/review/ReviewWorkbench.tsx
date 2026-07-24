"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type {
  ChannelCandidate,
  ReviewDecision,
} from "../../scripts/lost-found-crawler/schemas";

type Props = {
  generatedAt: string;
  candidates: ChannelCandidate[];
  initialDecisions: ReviewDecision[];
  reviewerName: string;
  venueNames: Record<string, string>;
  operatorNames: Record<string, string>;
};

type ViewFilter = "pending" | "reviewed" | "all";

const STORAGE_KEY = "berlin-lost-found-review-draft-v1";

function visibleFields(candidate: ChannelCandidate) {
  return candidate.form?.fields.filter((field) => field.control !== "hidden") ?? [];
}

function candidateWarning(candidate: ChannelCandidate): string {
  if (candidate.kind === "manual_review") {
    return "Evidence only: no safe publishable channel was extracted from this page.";
  }
  if (
    candidate.reasons.some((reason) =>
      reason.includes("no lost-property-specific purpose")
    )
  ) {
    return "This is a venue contact fallback, not a dedicated lost-property service.";
  }
  if (candidate.kind === "general_contact_form") {
    return "This is a general contact form. Confirm that the organisation will route a lost-property enquiry.";
  }
  if (candidate.form?.captcha) {
    return "The traveller must complete the CAPTCHA manually.";
  }
  return "Confirm the destination, scope and evidence before accepting.";
}

function decisionMap(decisions: ReviewDecision[]) {
  return new Map(decisions.map((decision) => [decision.candidateId, decision]));
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default function ReviewWorkbench({
  generatedAt,
  candidates,
  initialDecisions,
  reviewerName: initialReviewerName,
  venueNames,
  operatorNames,
}: Props) {
  const [reviewerName, setReviewerName] = useState(initialReviewerName);
  const [filter, setFilter] = useState<ViewFilter>("pending");
  const candidateIds = useMemo(
    () => new Set(candidates.map((candidate) => candidate.id)),
    [candidates]
  );
  const [decisions, setDecisions] = useState<ReviewDecision[]>(() =>
    initialDecisions.filter((decision) =>
      candidates.some((candidate) => candidate.id === decision.candidateId)
    )
  );
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [checkedFields, setCheckedFields] = useState<Record<string, string[]>>(
    {}
  );
  const [draftLoaded, setDraftLoaded] = useState(false);

  useEffect(() => {
    const restore = window.setTimeout(() => {
      try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved) {
          const parsed = JSON.parse(saved) as {
            generatedAt?: string;
            decisions?: ReviewDecision[];
            notes?: Record<string, string>;
            checkedFields?: Record<string, string[]>;
          };
          if (parsed.generatedAt === generatedAt) {
            if (Array.isArray(parsed.decisions)) {
              setDecisions(
                parsed.decisions.filter((decision) =>
                  candidateIds.has(decision.candidateId)
                )
              );
            }
            if (parsed.notes) setNotes(parsed.notes);
            if (parsed.checkedFields) setCheckedFields(parsed.checkedFields);
          }
        }
      } catch {
        // A malformed browser draft is ignored; the tracked review file remains authoritative.
      } finally {
        setDraftLoaded(true);
      }
    }, 0);
    return () => window.clearTimeout(restore);
  }, [candidateIds, generatedAt]);

  useEffect(() => {
    if (!draftLoaded) return;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ generatedAt, decisions, notes, checkedFields })
    );
  }, [checkedFields, decisions, draftLoaded, generatedAt, notes]);

  const decisionsByCandidate = useMemo(
    () => decisionMap(decisions),
    [decisions]
  );
  const visibleCandidates = candidates.filter((candidate) => {
    const reviewed = decisionsByCandidate.has(candidate.id);
    if (filter === "pending") return !reviewed;
    if (filter === "reviewed") return reviewed;
    return true;
  });
  const accepted = decisions.filter(
    (decision) => decision.decision === "accept"
  ).length;
  const rejected = decisions.filter(
    (decision) => decision.decision === "reject"
  ).length;

  const record = (
    candidate: ChannelCandidate,
    decision: ReviewDecision["decision"],
    submissionMode?: ReviewDecision["submissionMode"]
  ) => {
    const reviewer = reviewerName.trim();
    if (!reviewer) return;
    const next: ReviewDecision = {
      candidateId: candidate.id,
      decision,
      reviewedAt: new Date().toISOString(),
      reviewedBy: reviewer,
      notes: notes[candidate.id]?.trim() || undefined,
      kindOverride:
        decision === "accept" && candidate.kind !== "manual_review"
          ? candidate.kind
          : undefined,
      submissionMode: decision === "accept" ? submissionMode : undefined,
      reviewedContentHash:
        decision === "accept" &&
        (submissionMode === "assisted_fill" || submissionMode === "adapter")
          ? candidate.form?.contentHash
          : undefined,
    };
    setDecisions((current) => [
      ...current.filter((entry) => entry.candidateId !== candidate.id),
      next,
    ]);
  };

  const clearDecision = (candidateId: string) => {
    setDecisions((current) =>
      current.filter((entry) => entry.candidateId !== candidateId)
    );
  };

  return (
    <main className="min-h-screen bg-stone-100 px-4 py-8 text-stone-900 dark:bg-stone-950 dark:text-stone-100">
      <div className="mx-auto max-w-6xl">
        <Link
          href="/"
          className="text-sm font-medium text-orange-700 hover:underline dark:text-orange-300"
        >
          ← Traveller app
        </Link>
        <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-orange-700 dark:text-orange-300">
              Private maintenance
            </p>
            <h1 className="mt-1 text-3xl font-bold">Official channel review</h1>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-stone-600 dark:text-stone-300">
              Check who owns the destination, whether it really accepts lost-property
              enquiries, and every extracted field. Decisions stay in this browser
              until you download them; nothing here sends a form or publishes a channel.
            </p>
          </div>
          <button
            type="button"
            onClick={() =>
              downloadJson("reviews.json", {
                version: 1,
                decisions: [...decisions].sort((left, right) =>
                  left.candidateId.localeCompare(right.candidateId)
                ),
              })
            }
            disabled={!decisions.length}
            className="rounded-xl bg-stone-900 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40 dark:bg-orange-500 dark:text-stone-950"
          >
            Download {decisions.length} decision
            {decisions.length === 1 ? "" : "s"}
          </button>
        </div>

        <section className="mt-6 grid gap-3 rounded-2xl border border-stone-200 bg-white p-4 md:grid-cols-[minmax(220px,1fr)_auto] dark:border-stone-800 dark:bg-stone-900">
          <label className="text-sm font-medium">
            Reviewer name
            <input
              value={reviewerName}
              onChange={(event) => setReviewerName(event.target.value)}
              className="mt-1 block w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-950"
            />
          </label>
          <div className="flex flex-wrap items-end gap-2 text-xs">
            <span className="rounded-full bg-emerald-100 px-3 py-1.5 font-semibold text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200">
              {accepted} accepted
            </span>
            <span className="rounded-full bg-rose-100 px-3 py-1.5 font-semibold text-rose-800 dark:bg-rose-500/15 dark:text-rose-200">
              {rejected} rejected
            </span>
            <span className="rounded-full bg-stone-100 px-3 py-1.5 font-semibold text-stone-700 dark:bg-stone-800 dark:text-stone-200">
              {candidates.length - decisions.length} pending
            </span>
          </div>
        </section>

        <div className="mt-5 flex gap-2">
          {(["pending", "reviewed", "all"] as ViewFilter[]).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={`rounded-full px-3 py-1.5 text-xs font-semibold capitalize ${
                filter === value
                  ? "bg-orange-600 text-white"
                  : "bg-white text-stone-600 dark:bg-stone-900 dark:text-stone-300"
              }`}
            >
              {value}
            </button>
          ))}
        </div>

        <div className="mt-4 space-y-5">
          {visibleCandidates.map((candidate) => {
            const decision = decisionsByCandidate.get(candidate.id);
            const fields = visibleFields(candidate);
            const checked = new Set(checkedFields[candidate.id] ?? []);
            const allFieldsChecked =
              fields.length > 0 &&
              fields.every((field, index) =>
                checked.has(`${field.evidenceSelector}|${index}`)
              );
            return (
              <article
                key={candidate.id}
                className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm dark:border-stone-800 dark:bg-stone-900"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold">{candidate.kind}</h2>
                      <span className="rounded-full bg-stone-100 px-2 py-0.5 text-xs font-semibold dark:bg-stone-800">
                        {candidate.confidence}/100
                      </span>
                      {decision && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                            decision.decision === "accept"
                              ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-200"
                              : "bg-rose-100 text-rose-800 dark:bg-rose-500/15 dark:text-rose-200"
                          }`}
                        >
                          {decision.decision}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-stone-500">{candidate.id}</p>
                  </div>
                  <a
                    href={candidate.pageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-xl border border-stone-300 px-3 py-2 text-xs font-semibold hover:border-orange-500 dark:border-stone-700"
                  >
                    Open official page ↗
                  </a>
                </div>

                <div className="mt-4 grid gap-3 text-sm md:grid-cols-2">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">
                      Scope
                    </p>
                    <p className="mt-1">
                      {candidate.operatorId
                        ? operatorNames[candidate.operatorId] ?? candidate.operatorId
                        : candidate.venueIds
                            .map((id) => venueNames[id] ?? id)
                            .join(", ")}
                    </p>
                    {candidate.operatorId && (
                      <p className="mt-1 text-xs text-stone-500">
                        {candidate.venueIds.length} associated venues
                      </p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-stone-400">
                      Destination
                    </p>
                    <p className="mt-1 break-all">
                      {candidate.contactValue ?? candidate.pageUrl}
                    </p>
                  </div>
                </div>

                <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/5 dark:text-amber-100">
                  {candidateWarning(candidate)}
                </p>

                <details className="mt-4">
                  <summary className="cursor-pointer text-sm font-semibold">
                    Evidence and discovery path
                  </summary>
                  <ol className="mt-2 space-y-1 text-xs text-stone-500">
                    {candidate.discoveryPath.map((step, index) => (
                      <li key={`${step.url}-${index}`}>
                        {index + 1}. {step.label}
                      </li>
                    ))}
                  </ol>
                  <p className="mt-3 rounded-xl bg-stone-100 p-3 text-xs leading-5 text-stone-700 dark:bg-stone-950 dark:text-stone-300">
                    {candidate.evidence[0]?.excerpt || "No excerpt available."}
                  </p>
                </details>

                {fields.length > 0 && (
                  <div className="mt-4 overflow-x-auto">
                    <p className="mb-2 text-sm font-semibold">
                      Check every field before enabling assisted filling
                    </p>
                    <table className="w-full min-w-[620px] text-left text-xs">
                      <thead className="text-stone-500">
                        <tr>
                          <th className="pb-2">Checked</th>
                          <th className="pb-2">Official label</th>
                          <th className="pb-2">Meaning</th>
                          <th className="pb-2">Required</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fields.map((field, fieldIndex) => {
                          const reviewKey = `${field.evidenceSelector}|${fieldIndex}`;
                          return (
                          <tr
                            key={reviewKey}
                            className="border-t border-stone-100 dark:border-stone-800"
                          >
                            <td className="py-2">
                              <input
                                type="checkbox"
                                checked={checked.has(reviewKey)}
                                onChange={(event) => {
                                  const next = new Set(checked);
                                  if (event.target.checked) {
                                    next.add(reviewKey);
                                  } else {
                                    next.delete(reviewKey);
                                  }
                                  setCheckedFields((current) => ({
                                    ...current,
                                    [candidate.id]: [...next],
                                  }));
                                }}
                                aria-label={`Confirm ${field.label}`}
                              />
                            </td>
                            <td className="py-2 pr-3">{field.label}</td>
                            <td className="py-2 pr-3 font-mono">
                              {field.semanticKey}
                            </td>
                            <td className="py-2">{field.required ? "yes" : "no"}</td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                <label className="mt-4 block text-xs font-semibold text-stone-600 dark:text-stone-300">
                  Review note
                  <textarea
                    value={notes[candidate.id] ?? decision?.notes ?? ""}
                    onChange={(event) =>
                      {
                        const value = event.target.value;
                        setNotes((current) => ({
                          ...current,
                          [candidate.id]: value,
                        }));
                        setDecisions((current) =>
                          current.map((entry) =>
                            entry.candidateId === candidate.id
                              ? {
                                  ...entry,
                                  notes: value.trim() || undefined,
                                }
                              : entry
                          )
                        );
                      }
                    }
                    placeholder="Why is this correct, unsuitable, or limited?"
                    className="mt-1 min-h-20 w-full rounded-xl border border-stone-300 bg-white px-3 py-2 font-normal dark:border-stone-700 dark:bg-stone-950"
                  />
                </label>

                <div className="mt-4 flex flex-wrap gap-2">
                  {candidate.kind !== "manual_review" && (
                    <button
                      type="button"
                      disabled={!reviewerName.trim()}
                      onClick={() => record(candidate, "accept", "open_only")}
                      className="rounded-xl bg-emerald-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
                    >
                      Accept destination only
                    </button>
                  )}
                  {candidate.form && candidate.kind !== "manual_review" && (
                    <button
                      type="button"
                      disabled={!reviewerName.trim() || !allFieldsChecked}
                      onClick={() =>
                        record(candidate, "accept", "assisted_fill")
                      }
                      className="rounded-xl bg-sky-700 px-3 py-2 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-35"
                    >
                      Accept with filling guide
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={!reviewerName.trim()}
                    onClick={() => record(candidate, "reject")}
                    className="rounded-xl bg-rose-700 px-3 py-2 text-xs font-semibold text-white disabled:opacity-40"
                  >
                    Reject
                  </button>
                  {decision && (
                    <button
                      type="button"
                      onClick={() => clearDecision(candidate.id)}
                      className="rounded-xl border border-stone-300 px-3 py-2 text-xs font-semibold dark:border-stone-700"
                    >
                      Clear decision
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        {!visibleCandidates.length && (
          <p className="mt-8 rounded-2xl border border-dashed border-stone-300 p-8 text-center text-sm text-stone-500 dark:border-stone-700">
            Nothing in this view.
          </p>
        )}
      </div>
    </main>
  );
}
