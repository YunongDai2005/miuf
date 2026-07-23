"use client";

import type { ResolvedParty } from "../parties";
import { VerifiedBadge, VerifyBadge } from "../ui";

export default function StepParties({ resolved }: { resolved: ResolvedParty[] }) {
  if (resolved.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-stone-300 p-8 text-center text-sm text-stone-500 dark:border-stone-700">
        No itinerary yet. Go back a step and add the lines you rode and the places you visited so we can
        work out who to contact.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-stone-500 dark:text-stone-400">
        Based on your day, there are{" "}
        <span className="font-semibold text-stone-800 dark:text-stone-100">{resolved.length}</span>{" "}
        lost-property offices to contact along the way. The next step drafts a report for each.
      </p>

      <ol className="space-y-3">
        {resolved.map((r, i) => (
          <li
            key={r.party.id}
            className="rounded-2xl border border-stone-200 bg-white p-4 dark:border-stone-700 dark:bg-stone-900"
          >
            <div className="flex items-start gap-3">
              <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-orange-100 text-sm font-bold text-orange-700 dark:bg-orange-500/15 dark:text-orange-300">
                {i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                    {r.party.name}
                  </h3>
                  {r.party.verified ? (
                    <VerifiedBadge date={r.party.lastVerifiedAt} />
                  ) : (
                    <VerifyBadge />
                  )}
                </div>
                <p className="mt-0.5 text-xs text-stone-400">{r.party.scope}</p>
                <ul className="mt-2 space-y-1">
                  {r.reasons.map((reason, idx) => (
                    <li
                      key={idx}
                      className="flex gap-1.5 text-xs text-stone-600 dark:text-stone-300"
                    >
                      <span className="text-orange-500">·</span>
                      {reason}
                    </li>
                  ))}
                </ul>
                {r.party.nextStep && (
                  <p className="mt-3 rounded-xl bg-stone-50 px-3 py-2 text-xs leading-relaxed text-stone-600 dark:bg-stone-800/70 dark:text-stone-300">
                    <span className="font-semibold">Next: </span>
                    {r.party.nextStep}
                  </p>
                )}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
