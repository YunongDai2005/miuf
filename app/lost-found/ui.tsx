"use client";

import type { InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold text-white transition",
        "bg-orange-600 hover:bg-orange-500 active:scale-[.99]",
        "disabled:cursor-not-allowed disabled:bg-stone-300 disabled:text-stone-500 dark:disabled:bg-stone-700 dark:disabled:text-stone-500"
      )}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  onClick,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition",
        "text-stone-600 hover:bg-stone-100 disabled:opacity-40",
        "dark:text-stone-300 dark:hover:bg-stone-800"
      )}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline gap-2 text-sm font-medium text-stone-700 dark:text-stone-300">
        {label}
        {hint && <span className="text-xs font-normal text-stone-400">{hint}</span>}
      </span>
      {children}
    </label>
  );
}

const inputBase =
  "w-full rounded-xl border border-stone-200 bg-white px-3.5 py-2.5 text-sm text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-orange-400 focus:ring-2 focus:ring-orange-100 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:focus:ring-orange-500/20";

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputBase, props.className)} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(inputBase, "min-h-[76px] resize-y", props.className)} />;
}

export function VerifyBadge() {
  return (
    <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">
      check before sharing details
    </span>
  );
}

export function VerifiedBadge({ date }: { date?: string }) {
  const label = date
    ? `source checked · ${new Intl.DateTimeFormat("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(`${date}T00:00:00Z`))}`
    : "source checked";
  return (
    <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
      {label}
    </span>
  );
}
