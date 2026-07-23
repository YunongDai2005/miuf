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
        </div>
      </details>
    </div>
  );
}
