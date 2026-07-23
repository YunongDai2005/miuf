"use client";

import { useState, type ReactNode } from "react";
import type { ResolvedParty } from "../parties";
import {
  buildReportDrafts,
  calendarReminderHref,
  mailtoLink,
} from "../report";
import type { Contact, LostCase, ReportState } from "../types";
import { hasContact } from "../storage";
import { Field, TextInput, VerifiedBadge, VerifyBadge, cx } from "../ui";

const STATE_META: Record<ReportState, { label: string; className: string }> = {
  todo: {
    label: "To do",
    className: "bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300",
  },
  sent: {
    label: "Sent",
    className: "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300",
  },
  replied: {
    label: "Replied",
    className: "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300",
  },
};
const STATES: ReportState[] = ["todo", "sent", "replied"];

function ContactRow({
  label,
  source,
  children,
}: {
  label: string;
  source?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-2 text-xs">
      <span className="w-14 flex-none text-stone-400">
        {label}
        {source && (
          <a
            href={source}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Official source for ${label}`}
            title={`Official source for ${label}`}
            className="ml-1 text-[9px] text-stone-300 underline-offset-2 hover:text-orange-500 hover:underline"
          >
            source
          </a>
        )}
      </span>
      <span className="min-w-0 flex-1 text-stone-600 dark:text-stone-300">{children}</span>
    </div>
  );
}

function PartyCard({
  lostCase,
  resolved,
  state,
  onSetState,
}: {
  lostCase: LostCase;
  resolved: ResolvedParty;
  state: ReportState;
  onSetState: (s: ReportState) => void;
}) {
  const { party } = resolved;
  const drafts = buildReportDrafts(lostCase, resolved);
  const [copied, setCopied] = useState<"de" | "en" | null>(null);
  const reminder = calendarReminderHref(lostCase, resolved);

  const copy = async (lang: "de" | "en") => {
    try {
      await navigator.clipboard.writeText(lang === "de" ? drafts.de : drafts.en);
      setCopied(lang);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      /* clipboard blocked — user can still select the text */
    }
  };

  const formHref = party.formUrl || party.website || undefined;

  return (
    <li className="report-card overflow-hidden rounded-2xl border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900">
      <div className="border-b border-stone-100 p-4 dark:border-stone-800">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-stone-900 dark:text-stone-100">{party.name}</h3>
          {party.verified ? (
            <VerifiedBadge date={party.lastVerifiedAt} />
          ) : (
            <VerifyBadge />
          )}
          <span
            className={cx(
              "ml-auto rounded-full px-2.5 py-0.5 text-[11px] font-semibold",
              STATE_META[state].className
            )}
          >
            {party.guidanceOnly && state === "sent" ? "Done" : STATE_META[state].label}
          </span>
        </div>
        <p className="mt-1 text-xs text-stone-400">{party.operatorName} · {party.scope}</p>

        <div className="mt-3 space-y-1.5">
          <ContactRow label="Official" source={party.fieldSources.website}>
            <a
              href={party.website}
              target="_blank"
              rel="noopener noreferrer"
              className="break-all text-orange-600 underline-offset-2 hover:underline dark:text-orange-400"
            >
              {party.website}
            </a>
          </ContactRow>
          {party.formUrl && (
            <ContactRow label="Form" source={party.fieldSources.formUrl}>
              <a
                href={party.formUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-orange-600 underline-offset-2 hover:underline dark:text-orange-400"
              >
                {party.formUrl}
              </a>
            </ContactRow>
          )}
          {party.email && (
            <ContactRow label="Email" source={party.fieldSources.email}>
              {party.email}
            </ContactRow>
          )}
          {party.phone && (
            <ContactRow label="Phone" source={party.fieldSources.phone}>
              {party.phone}
            </ContactRow>
          )}
          {party.address && (
            <ContactRow label="Address" source={party.fieldSources.address}>
              {party.address}
            </ContactRow>
          )}
          {party.hours && (
            <ContactRow label="Hours" source={party.fieldSources.hours}>
              {party.hours}
            </ContactRow>
          )}
          {party.retention && (
            <ContactRow label="Timing" source={party.fieldSources.retention}>
              {party.retention}
            </ContactRow>
          )}
          {party.nextStep && (
            <ContactRow label="Next" source={party.fieldSources.nextStep}>
              <span className="font-medium text-stone-700 dark:text-stone-200">
                {party.nextStep}
              </span>
            </ContactRow>
          )}
          {party.note && (
            <ContactRow label="Caution" source={party.fieldSources.note}>
              <span className="text-amber-700 dark:text-amber-300">{party.note}</span>
            </ContactRow>
          )}
        </div>
      </div>

      <div className="space-y-3 p-4">
        {/* Actions */}
        <div className="no-print flex flex-wrap gap-2">
          {party.email && (
            <a
              href={mailtoLink(party.email, drafts.subject, drafts.de)}
              className="inline-flex items-center gap-1.5 rounded-xl bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-orange-500"
            >
              ✉️ Send by email
            </a>
          )}
          {formHref && (
            <a
              href={formHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-xl border border-stone-200 px-3.5 py-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
            >
              ↗ {party.formLabel ?? "Open official form"}
            </a>
          )}
          {party.relatedLinks?.map((link) => (
            <a
              key={link.url}
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-xl border border-stone-200 px-3.5 py-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
            >
              ↗ {link.label}
            </a>
          ))}
          {!party.guidanceOnly && (
            <>
              <button
                type="button"
                onClick={() => copy("de")}
                className="inline-flex items-center gap-1.5 rounded-xl border border-stone-200 px-3.5 py-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
              >
                {copied === "de" ? "✓ Copied" : "Copy German"}
              </button>
              <button
                type="button"
                onClick={() => copy("en")}
                className="inline-flex items-center gap-1.5 rounded-xl border border-stone-200 px-3.5 py-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
              >
                {copied === "en" ? "✓ Copied" : "Copy English"}
              </button>
            </>
          )}
          {reminder && (
            <a
              href={reminder.href}
              download={reminder.filename}
              className="inline-flex items-center gap-1.5 rounded-xl border border-stone-200 px-3.5 py-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
            >
              ◷ Add follow-up reminder
            </a>
          )}
        </div>

        {/* Draft preview */}
        {!party.guidanceOnly && (
          <details className="report-draft group rounded-xl bg-stone-50 dark:bg-stone-800/50">
            <summary className="cursor-pointer list-none px-3.5 py-2.5 text-xs font-semibold text-stone-600 dark:text-stone-300">
              <span className="group-open:hidden">
                View the auto-generated German / English report ▾
              </span>
              <span className="hidden group-open:inline">Hide report ▴</span>
            </summary>
            <div className="grid gap-3 px-3.5 pb-3.5 sm:grid-cols-2">
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
                  German
                </p>
                <textarea
                  readOnly
                  value={drafts.de}
                  className="h-52 w-full resize-y rounded-lg border border-stone-200 bg-white p-2.5 text-[11px] leading-relaxed text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200"
                />
              </div>
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-stone-400">
                  English
                </p>
                <textarea
                  readOnly
                  value={drafts.en}
                  className="h-52 w-full resize-y rounded-lg border border-stone-200 bg-white p-2.5 text-[11px] leading-relaxed text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200"
                />
              </div>
            </div>
          </details>
        )}

        {/* Status tracker */}
        <div className="no-print flex items-center gap-2 pt-1">
          <span className="text-xs text-stone-400">Status</span>
          {(party.guidanceOnly ? STATES.slice(0, 2) : STATES).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onSetState(s)}
              className={cx(
                "rounded-full px-2.5 py-1 text-[11px] font-semibold transition",
                state === s
                  ? STATE_META[s].className
                  : "text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
              )}
            >
              {party.guidanceOnly && s === "sent" ? "Done" : STATE_META[s].label}
            </button>
          ))}
        </div>
      </div>
    </li>
  );
}

function ContactPrompt({
  contact,
  onContact,
}: {
  contact: Contact;
  onContact: (patch: Partial<Contact>) => void;
}) {
  const ready = hasContact(contact);
  return (
    <div
      className={cx(
        "rounded-2xl border p-4",
        ready
          ? "border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900"
          : "border-orange-300 bg-orange-50/60 dark:border-orange-500/40 dark:bg-orange-500/10"
      )}
    >
      <p className="mb-1 text-sm font-semibold text-stone-800 dark:text-stone-100">
        Leave one contact detail{" "}
        <span className="text-xs font-normal text-stone-400">the office replies to you here — just one is enough</span>
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Email">
          <TextInput
            type="email"
            value={contact.email}
            onChange={(e) => onContact({ email: e.target.value })}
            placeholder="name@example.com"
          />
        </Field>
        <Field label="Phone" hint="include country code">
          <TextInput
            value={contact.phone ?? ""}
            onChange={(e) => onContact({ phone: e.target.value })}
            placeholder="+49 …"
          />
        </Field>
      </div>
      <details className="group mt-2">
        <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-stone-400 hover:text-stone-600 dark:hover:text-stone-300">
          <span className="transition group-open:rotate-90">▸</span> Add your name (optional, some forms need it)
        </summary>
        <div className="mt-2">
          <TextInput
            value={contact.name}
            onChange={(e) => onContact({ name: e.target.value })}
            placeholder="Your name"
          />
        </div>
      </details>
      {!ready && (
        <p className="mt-2 text-xs text-orange-700 dark:text-orange-300">
          Add one contact detail to complete the reports below.
        </p>
      )}
    </div>
  );
}

export default function StepReport({
  lostCase,
  resolved,
  onSetState,
  onContact,
}: {
  lostCase: LostCase;
  resolved: ResolvedParty[];
  onSetState: (partyId: string, state: ReportState) => void;
  onContact: (patch: Partial<Contact>) => void;
}) {
  if (resolved.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-stone-300 p-8 text-center text-sm text-stone-500 dark:border-stone-700">
        Nothing to report yet. Add lines or places under “Retrace” first.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 dark:border-stone-700 dark:bg-stone-900">
        <div>
          <p className="text-sm font-semibold text-stone-800 dark:text-stone-100">
            Keep a case sheet with you
          </p>
          <p className="text-xs text-stone-400">
            Print or save this contact plan as a PDF before visiting an office.
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-xl border border-stone-200 px-3.5 py-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
        >
          Print case sheet
        </button>
      </div>
      {resolved.some((entry) => !entry.party.guidanceOnly) && (
        <div className="no-print">
          <ContactPrompt contact={lostCase.contact} onContact={onContact} />
        </div>
      )}
      <p className="text-sm text-stone-500 dark:text-stone-400">
        Each office already has a German / English report drafted from your details. Ones with an intake
        email can be sent in one tap; for the rest, copy the text into the official form and track your
        progress below.
      </p>
      <ol className="case-sheet space-y-3">
        {resolved.map((r) => (
          <PartyCard
            key={r.party.id}
            lostCase={lostCase}
            resolved={r}
            state={lostCase.reported[r.party.id] ?? "todo"}
            onSetState={(s) => onSetState(r.party.id, s)}
          />
        ))}
      </ol>
    </div>
  );
}
