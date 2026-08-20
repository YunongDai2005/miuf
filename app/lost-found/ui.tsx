"use client";

import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  TextareaHTMLAttributes,
} from "react";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function PrimaryButton({
  children,
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cx("lf-ui-button lf-ui-button--primary", className)}
      {...props}
    >
      {children}
    </button>
  );
}

export function GhostButton({
  children,
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cx("lf-ui-button lf-ui-button--ghost", className)}
      {...props}
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
    <label className="lf-ui-field">
      <span className="lf-ui-field-label">
        {label}
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </label>
  );
}

const inputBase = "lf-ui-input";

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputBase, props.className)} />;
}

export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cx(inputBase, "lf-ui-textarea", props.className)} />;
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "info" | "success" | "warning";
}) {
  return <span className={`lf-ui-badge lf-ui-badge--${tone}`}>{children}</span>;
}

export function VerifyBadge() {
  return (
    <Badge tone="warning">
      check before sharing details
    </Badge>
  );
}

export function verifiedDateLabel(date?: string): string {
  if (!date) return "source checked";
  const parsed = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T00:00:00Z` : date
  );
  if (!Number.isFinite(parsed.getTime())) return "source checked";
  return `source checked · ${new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed)}`;
}

export function VerifiedBadge({ date }: { date?: string }) {
  const label = verifiedDateLabel(date);
  return <Badge tone="success">{label}</Badge>;
}
