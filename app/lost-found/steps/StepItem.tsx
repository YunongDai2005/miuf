"use client";

import { ITEM_CATEGORY_META, type ItemCategory, type LostItem } from "../types";
import { Field, TextArea, TextInput, cx } from "../ui";
import { addCalendarDays, berlinDateKey } from "../time";

const CATEGORIES = Object.keys(ITEM_CATEGORY_META) as ItemCategory[];

function todayLabel(date: string): string {
  const today = berlinDateKey();
  if (date === today) return "Today";
  const yesterday = addCalendarDays(today, -1);
  if (date === yesterday) return "Yesterday";
  return new Date(date + "T00:00:00").toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export default function StepItem({
  item,
  onItem,
}: {
  item: LostItem;
  onItem: (patch: Partial<LostItem>) => void;
}) {
  return (
    <div className="space-y-5">
      {/* Optional one-tap category */}
      <div className="flex flex-wrap gap-2">
        {CATEGORIES.map((category) => {
          const meta = ITEM_CATEGORY_META[category];
          const active = item.category === category;
          return (
            <button
              key={category}
              type="button"
              onClick={() => onItem({ category: active ? null : category })}
              className={cx(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition",
                active
                  ? "border-orange-400 bg-orange-50 text-orange-700 dark:border-orange-500/60 dark:bg-orange-500/10 dark:text-orange-300"
                  : "border-stone-200 text-stone-600 hover:border-stone-300 dark:border-stone-700 dark:text-stone-400 dark:hover:border-stone-600"
              )}
            >
              <span className="text-base leading-none">{meta.emoji}</span>
              {meta.label}
            </button>
          );
        })}
      </div>

      {item.category === "documents" && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm dark:border-rose-500/30 dark:bg-rose-500/10">
          <p className="font-semibold text-rose-900 dark:text-rose-100">
            Passport or ID missing?
          </p>
          <p className="mt-1 text-xs leading-relaxed text-rose-800 dark:text-rose-200">
            Report a lost or stolen passport to the police immediately. If you
            are visiting Berlin and need to travel, contact your country’s
            embassy as well.
          </p>
          <a
            href="https://www.berlin.de/en/tourism/travel-information/1735948-2862820-lost-and-found-and-lost-property-offices.en.html"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex text-xs font-semibold text-rose-800 underline underline-offset-2 dark:text-rose-200"
          >
            Open Berlin’s official guidance ↗
          </a>
        </div>
      )}

      {(item.category === "wallet" || item.category === "phone") && (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm dark:border-amber-500/30 dark:bg-amber-500/10">
          <p className="font-semibold text-amber-900 dark:text-amber-100">
            Protect your accounts first
          </p>
          <p className="mt-1 text-xs leading-relaxed text-amber-800 dark:text-amber-200">
            {item.category === "wallet"
              ? "Block payment cards now through your bank. If the wallet may have been stolen, report the theft to police."
              : "Block the SIM and secure the device now. If the phone may have been stolen, keep the IMEI number for the police report."}
          </p>
          <a
            href="https://www.berlin.de/en/tourism/travel-information/2832639-2862820-pickpockets.en.html"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-flex text-xs font-semibold text-amber-800 underline underline-offset-2 dark:text-amber-200"
          >
            Open Berlin’s official safety steps ↗
          </a>
        </div>
      )}

      {/* The one field that matters */}
      <Field label="Describe what you lost, in one line" hint="colour, brand, what's inside…">
        <TextArea
          value={item.description}
          onChange={(e) => onItem({ description: e.target.value })}
          placeholder="e.g. Black Fjällräven backpack with a passport, a notebook, and a panda charm on the zip"
          autoFocus
        />
      </Field>

      {/* Date defaults to today; one tap to change */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-stone-500 dark:text-stone-400">Date lost</span>
        <input
          type="date"
          value={item.lostDate}
          max={berlinDateKey()}
          onChange={(e) => e.target.value && onItem({ lostDate: e.target.value })}
          aria-label="Date lost"
          className="rounded-xl border border-stone-200 bg-white px-3 py-1.5 text-sm text-stone-800 outline-none transition focus:border-orange-400 focus:ring-2 focus:ring-orange-100 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:focus:ring-orange-500/20"
        />
        <span className="text-xs font-medium text-stone-400">{todayLabel(item.lostDate)}</span>
      </div>

      <label className="flex cursor-pointer items-start gap-3 rounded-2xl border border-stone-200 bg-white p-3.5 dark:border-stone-700 dark:bg-stone-900">
        <input
          type="checkbox"
          checked={Boolean(item.includeCentralOffice)}
          onChange={(event) =>
            onItem({ includeCentralOffice: event.target.checked })
          }
          className="mt-0.5 h-4 w-4 rounded border-stone-300 text-orange-600 focus:ring-orange-500"
        />
        <span>
          <span className="block text-sm font-medium text-stone-700 dark:text-stone-200">
            I am not sure where I lost it
          </span>
          <span className="mt-0.5 block text-xs leading-relaxed text-stone-400">
            Include Berlin’s city-wide lost-property search for streets, taxis
            and uncertain locations. Leave this off if your possible locations
            are only the operators and venues you add next.
          </span>
        </span>
      </label>

      {/* Everything else is optional and out of the way */}
      <details className="group">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-sm font-medium text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200">
          <span className="transition group-open:rotate-90">▸</span> More details (optional)
        </summary>
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <Field label="Approx. time lost · from">
            <TextInput
              type="time"
              value={item.timeFrom ?? ""}
              onChange={(e) => onItem({ timeFrom: e.target.value })}
            />
          </Field>
          <Field label="Approx. time lost · to">
            <TextInput
              type="time"
              value={item.timeTo ?? ""}
              onChange={(e) => onItem({ timeTo: e.target.value })}
            />
          </Field>
          <Field label="Brand">
            <TextInput
              value={item.brand ?? ""}
              onChange={(e) => onItem({ brand: e.target.value })}
              placeholder="e.g. Fjällräven"
            />
          </Field>
          <Field label="Colour">
            <TextInput
              value={item.color ?? ""}
              onChange={(e) => onItem({ color: e.target.value })}
              placeholder="e.g. black"
            />
          </Field>
          <Field label="Identifying features">
            <TextInput
              value={item.identifyingFeatures ?? ""}
              onChange={(e) => onItem({ identifyingFeatures: e.target.value })}
              placeholder="e.g. panda charm on the zip"
            />
          </Field>
          <Field label="Approximate value">
            <TextInput
              value={item.estimatedValue ?? ""}
              onChange={(e) => onItem({ estimatedValue: e.target.value })}
              placeholder="e.g. €80"
            />
          </Field>
          <Field label="City or postcode where it was lost">
            <TextInput
              value={item.lossCity ?? ""}
              onChange={(e) => onItem({ lossCity: e.target.value })}
              placeholder="e.g. Berlin 10117"
            />
          </Field>
        </div>
      </details>
    </div>
  );
}
