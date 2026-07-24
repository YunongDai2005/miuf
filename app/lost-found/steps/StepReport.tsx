"use client";

import { useState, type ReactNode } from "react";
import type { ResolvedParty } from "../parties";
import {
  buildReportDrafts,
  calendarReminderHref,
  mailtoLink,
} from "../report";
import type {
  Contact,
  LostCase,
  ReportState,
  SubmissionRecord,
} from "../types";
import { hasContact } from "../storage";
import { buildFormGuide } from "../formGuide";
import {
  nextSubmissionRecord,
  submissionRecordFromOutcome,
  submissionFingerprint,
} from "../submission";
import { buildAutofillPackage } from "../autofill";
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

function telephoneHref(phone: string): string {
  const withoutInternationalTrunk = phone.replace(
    /^(\s*(?:\+|00)\s*\d{1,3})\s*\(\s*0\s*\)/,
    "$1"
  );
  return `tel:${withoutInternationalTrunk.replace(/[^\d+]/g, "")}`;
}

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
  contactReady,
  onSetState,
  onSubmission,
}: {
  lostCase: LostCase;
  resolved: ResolvedParty;
  state: ReportState;
  contactReady: boolean;
  onSetState: (s: ReportState) => void;
  onSubmission: (record: SubmissionRecord) => void;
}) {
  const { party } = resolved;
  const drafts = buildReportDrafts(lostCase, resolved);
  const [copied, setCopied] = useState<"de" | "en" | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [copiedPackage, setCopiedPackage] = useState(false);
  const [helperResult, setHelperResult] = useState("");
  const [helperResultError, setHelperResultError] = useState("");
  const reminder = calendarReminderHref(lostCase, resolved);
  const formGuide = buildFormGuide(lostCase, resolved);
  const fingerprint = submissionFingerprint(lostCase, resolved);
  const previousSubmission = lostCase.submissions[party.id]?.find(
    (submission) => submission.fingerprint === fingerprint
  );
  const sameReport = Boolean(previousSubmission);
  const [receipt, setReceipt] = useState(
    sameReport ? previousSubmission?.receipt ?? "" : ""
  );
  const autofillPackage = buildAutofillPackage(lostCase, resolved);

  const copy = async (lang: "de" | "en") => {
    if (!contactReady) return;
    try {
      await navigator.clipboard.writeText(lang === "de" ? drafts.de : drafts.en);
      setCopied(lang);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      /* clipboard blocked — user can still select the text */
    }
  };

  const formHref = party.formUrl || party.website || undefined;
  const copyField = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedField(key);
      setTimeout(() => setCopiedField(null), 1600);
    } catch {
      /* The value remains visible and selectable if clipboard access is blocked. */
    }
  };
  const recordSubmission = (
    status: SubmissionRecord["status"],
    nextReceipt?: string
  ) => {
    onSubmission(
      nextSubmissionRecord({
        partyId: party.id,
        fingerprint,
        status,
        receipt: nextReceipt,
      })
    );
  };
  const copyAutofillPackage = async () => {
    if (!autofillPackage) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(autofillPackage));
      setCopiedPackage(true);
      setTimeout(() => setCopiedPackage(false), 1600);
    } catch {
      /* Field-by-field values remain available when clipboard access is blocked. */
    }
  };
  const importHelperResult = () => {
    try {
      const record = submissionRecordFromOutcome(JSON.parse(helperResult), {
        partyId: party.id,
        channelId: party.channelId ?? party.id,
        fingerprint,
      });
      onSubmission(record);
      if (
        record.status === "user_confirmed" ||
        record.status === "receipt_confirmed"
      ) {
        onSetState("sent");
      }
      if (record.receipt) setReceipt(record.receipt);
      setHelperResult("");
      setHelperResultError("");
    } catch (error) {
      setHelperResultError(
        error instanceof Error
          ? error.message
          : "The helper result could not be imported."
      );
    }
  };

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
        <p className="mt-1 text-xs text-stone-400">
          {party.operatorName} · {party.scope}
        </p>

        {party.nextStep && (
          <p className="mt-3 rounded-xl bg-orange-50 px-3 py-2.5 text-xs leading-relaxed text-orange-900 dark:bg-orange-500/10 dark:text-orange-100">
            <span className="font-semibold">What to do: </span>
            {party.nextStep}
          </p>
        )}
        {party.note && (
          <p className="mt-2 rounded-xl bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
            {party.note}
          </p>
        )}

        <details className="group mt-3 rounded-xl border border-stone-200 dark:border-stone-700">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-semibold text-stone-600 dark:text-stone-300">
            <span className="group-open:hidden">
              Contact details and official sources ▾
            </span>
            <span className="hidden group-open:inline">
              Hide contact details ▴
            </span>
          </summary>
          <div className="space-y-1.5 border-t border-stone-100 px-3 py-3 dark:border-stone-800">
            <ContactRow label="Website" source={party.fieldSources.website}>
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
          </div>
        </details>
      </div>

      <div className="space-y-3 p-4">
        {/* Actions */}
        <div className="no-print flex flex-wrap gap-2">
          {party.email && contactReady && (
            <a
              href={mailtoLink(party.email, drafts.subject, drafts.de)}
              onClick={() => recordSubmission("opened")}
              className="inline-flex items-center gap-1.5 rounded-xl bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-orange-500"
            >
              ✉️ Send by email
            </a>
          )}
          {party.email && !contactReady && (
            <button
              type="button"
              disabled
              title="Add an email address or phone number above first"
              className="inline-flex items-center gap-1.5 rounded-xl bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white opacity-40"
            >
              ✉️ Add your contact before emailing
            </button>
          )}
          {party.channelKind === "phone" && party.phone && (
            <a
              href={telephoneHref(party.phone)}
              onClick={() => recordSubmission("opened")}
              className="inline-flex items-center gap-1.5 rounded-xl bg-orange-600 px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-orange-500"
            >
              ☎ Call reviewed number
            </a>
          )}
          {formHref && (
            <a
              href={formHref}
              onClick={() => recordSubmission("opened")}
              target="_blank"
              rel="noopener noreferrer"
              className={cx(
                "inline-flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold transition",
                party.email && contactReady
                  ? "border border-stone-200 text-stone-700 hover:bg-stone-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
                  : "bg-orange-600 text-white hover:bg-orange-500"
              )}
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
                disabled={!contactReady}
                onClick={() => copy("de")}
                className="inline-flex items-center gap-1.5 rounded-xl border border-stone-200 px-3.5 py-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
              >
                {copied === "de" ? "✓ Copied" : "Copy German"}
              </button>
              <button
                type="button"
                disabled={!contactReady}
                onClick={() => copy("en")}
                className="inline-flex items-center gap-1.5 rounded-xl border border-stone-200 px-3.5 py-2 text-xs font-semibold text-stone-700 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
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

        {Boolean(party.alternativeChannels?.length) && (
          <details className="no-print rounded-xl border border-sky-200 bg-sky-50/60 dark:border-sky-500/30 dark:bg-sky-500/5">
            <summary className="cursor-pointer list-none px-3.5 py-2.5 text-xs font-semibold text-sky-800 dark:text-sky-200">
              Verified backup channels ({party.alternativeChannels?.length})
            </summary>
            <div className="space-y-2 px-3.5 pb-3.5">
              <p className="text-[11px] leading-relaxed text-sky-800 dark:text-sky-200">
                Use a backup only if the primary route above is unavailable or
                tells you to follow up elsewhere. Sending the same report through
                every channel can create duplicate cases.
              </p>
              <div className="flex flex-wrap gap-2">
                {party.alternativeChannels?.map((channel) => (
                  <a
                    key={channel.id}
                    href={channel.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="rounded-lg border border-sky-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-sky-700 hover:bg-sky-50 dark:border-sky-500/30 dark:bg-stone-900 dark:text-sky-300"
                  >
                    ↗ {channel.label}
                  </a>
                ))}
              </div>
            </div>
          </details>
        )}

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

        {formGuide.length > 0 && (
          <details className="no-print group rounded-xl border border-sky-200 bg-sky-50/60 dark:border-sky-500/30 dark:bg-sky-500/5">
            <summary className="cursor-pointer list-none px-3.5 py-2.5 text-xs font-semibold text-sky-800 dark:text-sky-200">
              <span className="group-open:hidden">
                Form-filling help ({formGuide.length} fields) ▾
              </span>
              <span className="hidden group-open:inline">
                Hide form-filling help ▴
              </span>
            </summary>
            <div className="space-y-2 px-3.5 pb-3.5">
              {autofillPackage && (
                <div className="rounded-lg border border-sky-200 bg-white p-3 dark:border-sky-500/20 dark:bg-stone-900">
                  <p className="text-[11px] leading-relaxed text-stone-500 dark:text-stone-400">
                    Using the optional browser helper? Copy the reviewed field
                    data after opening the official form.
                  </p>
                  <button
                    type="button"
                    onClick={copyAutofillPackage}
                    className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-sky-200 px-3 py-1.5 text-xs font-semibold text-sky-700 transition hover:bg-sky-50 dark:border-sky-500/30 dark:text-sky-300 dark:hover:bg-sky-500/10"
                  >
                    {copiedPackage
                      ? "✓ Helper data copied"
                      : "Copy form helper data"}
                  </button>
                </div>
              )}
              {(party.captcha || party.loginRequired) && (
                <p className="rounded-lg bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800 dark:bg-amber-500/10 dark:text-amber-200">
                  {party.loginRequired
                    ? "This form requires sign-in. "
                    : ""}
                  {party.captcha ? "Complete the CAPTCHA yourself. " : ""}
                  The helper never bypasses these checks. Submission is
                  available only for a separately reviewed official form and
                  always asks for confirmation again.
                </p>
              )}
              {formGuide.map((entry, index) => {
                const key =
                  entry.field.rawName ?? entry.field.rawId ?? `${entry.field.label}-${index}`;
                return (
                  <div
                    key={key}
                    className="rounded-lg border border-sky-100 bg-white px-3 py-2 dark:border-sky-500/20 dark:bg-stone-900"
                  >
                    <div className="flex items-start gap-2">
                      <div className="min-w-0 flex-1">
                        <p className="text-[11px] font-semibold text-stone-700 dark:text-stone-200">
                          {entry.field.label}
                          {entry.field.required && (
                            <span className="ml-1 text-rose-500">required</span>
                          )}
                        </p>
                        {entry.suggestedValue ? (
                          <p className="mt-1 break-words text-xs text-stone-600 dark:text-stone-300">
                            {entry.suggestedValue}
                          </p>
                        ) : (
                          <p className="mt-1 text-[11px] text-amber-700 dark:text-amber-300">
                            {entry.note ??
                              (entry.needsUserInput
                                ? "Complete this field on the official website."
                                : "No value suggested.")}
                          </p>
                        )}
                      </div>
                      {entry.suggestedValue && (
                        <button
                          type="button"
                          onClick={() => copyField(key, entry.suggestedValue as string)}
                          className="rounded-lg border border-sky-200 px-2 py-1 text-[10px] font-semibold text-sky-700 hover:bg-sky-50 dark:border-sky-500/30 dark:text-sky-300 dark:hover:bg-sky-500/10"
                        >
                          {copiedField === key ? "Copied" : "Copy"}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </details>
        )}

        {sameReport && previousSubmission && (
          <div className="no-print rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
            This exact report was already{" "}
            {previousSubmission.status === "opened"
              ? "opened"
              : previousSubmission.status === "receipt_confirmed"
                ? "saved with a receipt"
                : previousSubmission.status === "uncertain"
                  ? "attempted with an uncertain result"
                : "marked as sent"}{" "}
            on {new Date(previousSubmission.updatedAt).toLocaleString()}. Check its status before
            sending it again.
          </div>
        )}

        {!party.guidanceOnly && (
          <details className="no-print rounded-xl border border-stone-200 bg-white dark:border-stone-700 dark:bg-stone-900">
            <summary className="cursor-pointer list-none px-3 py-2 text-[11px] font-semibold text-stone-600 dark:text-stone-300">
              Save a case number or receipt
            </summary>
            <div className="flex flex-wrap gap-2 px-3 pb-3">
              <input
                value={receipt}
                onChange={(event) => setReceipt(event.target.value)}
                placeholder="Case number or receipt URL"
                maxLength={500}
                className="min-w-52 flex-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs text-stone-700 outline-none focus:border-orange-400 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-200"
              />
              <button
                type="button"
                disabled={!receipt.trim()}
                onClick={() => recordSubmission("receipt_confirmed", receipt)}
                className="rounded-lg bg-stone-800 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40 dark:bg-stone-100 dark:text-stone-900"
              >
                Save receipt
              </button>
            </div>
            {autofillPackage && (
              <div className="border-t border-stone-100 px-3 py-3 dark:border-stone-800">
                <p className="text-[11px] leading-5 text-stone-500 dark:text-stone-400">
                  If the browser helper submitted this report, paste its copied
                  result here. The exact report and destination must match
                  before it is added to this case.
                </p>
                <textarea
                  value={helperResult}
                  onChange={(event) => {
                    setHelperResult(event.target.value);
                    setHelperResultError("");
                  }}
                  placeholder="{ helper result }"
                  aria-label="Browser helper result"
                  className="mt-2 h-20 w-full resize-y rounded-lg border border-stone-200 bg-white p-2 font-mono text-[10px] text-stone-700 outline-none focus:border-orange-400 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-200"
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={!helperResult.trim()}
                    onClick={importHelperResult}
                    className="rounded-lg border border-stone-300 px-3 py-1.5 text-xs font-semibold disabled:opacity-40 dark:border-stone-700"
                  >
                    Import helper result
                  </button>
                  {helperResultError && (
                    <span
                      className="text-[11px] text-rose-700 dark:text-rose-300"
                      role="alert"
                    >
                      {helperResultError}
                    </span>
                  )}
                </div>
              </div>
            )}
          </details>
        )}

        {/* Status tracker */}
        <div className="no-print flex items-center gap-2 pt-1">
          <span className="text-xs text-stone-400">Status</span>
          {(party.guidanceOnly ? STATES.slice(0, 2) : STATES).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                onSetState(s);
                if (s === "sent") recordSubmission("user_confirmed");
              }}
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
        Where should the offices reply?
      </p>
      <p className="text-xs leading-relaxed text-stone-500 dark:text-stone-400">
        Add an email address or phone number. One is enough to prepare the
        reports; if an official form requires a specific contact field, its
        filling guide will point that out. These details are used only inside
        the reports you choose to send.
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
          <span className="transition group-open:rotate-90">▸</span> Add name or postal address (optional)
        </summary>
        <div className="mt-2">
          <TextInput
            value={contact.name}
            onChange={(e) => onContact({ name: e.target.value })}
            placeholder="Your name"
          />
          <div className="mt-2">
            <TextInput
              value={contact.postalAddress ?? ""}
              onChange={(e) => onContact({ postalAddress: e.target.value })}
              placeholder="Postal address"
            />
          </div>
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
  onSubmission,
}: {
  lostCase: LostCase;
  resolved: ResolvedParty[];
  onSetState: (partyId: string, state: ReportState) => void;
  onContact: (patch: Partial<Contact>) => void;
  onSubmission: (record: SubmissionRecord) => void;
}) {
  if (resolved.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-stone-300 p-8 text-center text-sm text-stone-500 dark:border-stone-700">
        Nothing to report yet. Add lines or places under “Retrace” first.
      </div>
    );
  }
  const contactReady = hasContact(lostCase.contact);
  const completed = resolved.filter((entry) => {
    const state = lostCase.reported[entry.party.id] ?? "todo";
    return state === "sent" || state === "replied";
  }).length;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-orange-200 bg-orange-50/70 p-4 dark:border-orange-500/30 dark:bg-orange-500/10">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-semibold text-stone-900 dark:text-stone-100">
            Your action plan
          </p>
          <span className="rounded-full bg-white px-2.5 py-1 text-[11px] font-semibold text-orange-700 dark:bg-stone-900 dark:text-orange-300">
            {completed} of {resolved.length} completed
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-stone-600 dark:text-stone-300">
          Open each official destination, review the prepared German or English
          text, submit it yourself, then mark it sent here. This app never sends
          a report in the background.
        </p>
      </div>
      {resolved.some((entry) => !entry.party.guidanceOnly) && (
        <div className="no-print">
          <ContactPrompt contact={lostCase.contact} onContact={onContact} />
        </div>
      )}
      <p className="text-sm text-stone-500 dark:text-stone-400">
        Start with the first card. Backup links and field-by-field form help
        stay folded away until you need them.
      </p>
      <ol className="case-sheet space-y-3">
        {resolved.map((r) => (
          <PartyCard
            key={`${r.party.id}:${submissionFingerprint(lostCase, r)}`}
            lostCase={lostCase}
            resolved={r}
            state={lostCase.reported[r.party.id] ?? "todo"}
            contactReady={contactReady}
            onSetState={(s) => onSetState(r.party.id, s)}
            onSubmission={onSubmission}
          />
        ))}
      </ol>
      <div className="no-print flex flex-wrap items-center justify-between gap-3 rounded-xl border border-stone-200 bg-white px-4 py-3 dark:border-stone-700 dark:bg-stone-900">
        <div>
          <p className="text-sm font-semibold text-stone-800 dark:text-stone-100">
            Need an offline copy?
          </p>
          <p className="text-xs text-stone-400">
            Print or save this action plan as a PDF.
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
    </div>
  );
}
