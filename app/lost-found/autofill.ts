import type { FormControl } from "../../lib/lost-found-channel-schema";
import { buildFormGuide } from "./formGuide";
import type { ResolvedParty } from "./parties";
import { submissionFingerprint } from "./submission";
import type { LostCase } from "./types";

export interface AutofillField {
  selector: string;
  label: string;
  control: FormControl;
  value: string;
}

export interface ManualRequiredField {
  selector: string;
  label: string;
  control: FormControl;
}

export interface AutofillPackage {
  version: 1;
  channelId: string;
  pageUrl: string;
  fingerprint: string;
  createdAt: string;
  expiresAt: string;
  submitAllowed: boolean;
  adapterId?: string;
  formContentHash?: string;
  fields: AutofillField[];
  /** Required controls the helper must verify but must never choose for the user. */
  manualRequiredFields: ManualRequiredField[];
}

export function buildAutofillPackage(
  lostCase: LostCase,
  resolved: ResolvedParty,
  now = new Date()
): AutofillPackage | null {
  const { party } = resolved;
  if (
    !party.formUrl ||
      (party.submissionMode !== "assisted_fill" &&
        party.submissionMode !== "adapter") ||
    !party.formFields?.length
  ) {
    return null;
  }
  const guide = buildFormGuide(lostCase, resolved);
  const fields = guide
    .filter(
      (entry) =>
        (entry.field.control === "select"
          ? entry.autofillValue
          : entry.suggestedValue) &&
        entry.field.semanticKey !== "privacyConsent" &&
        entry.field.semanticKey !== "attachment" &&
        entry.field.control !== "hidden" &&
        entry.field.control !== "file" &&
        entry.field.control !== "checkbox" &&
        entry.field.control !== "radio"
    )
    .map((entry) => ({
      selector: entry.field.evidenceSelector,
      label: entry.field.label,
      control: entry.field.control,
      value: (entry.autofillValue ?? entry.suggestedValue) as string,
    }));
  const manualRequiredFields = guide
    .filter(
      (entry) =>
        entry.field.required &&
        (entry.needsUserInput ||
          entry.field.semanticKey === "privacyConsent" ||
          entry.field.semanticKey === "attachment" ||
          entry.field.control === "file" ||
          entry.field.control === "checkbox" ||
          entry.field.control === "radio")
    )
    .map((entry) => ({
      selector: entry.field.evidenceSelector,
      label: entry.field.label,
      control: entry.field.control,
    }));
  if (!fields.length && !manualRequiredFields.length) return null;
  return {
    version: 1,
    channelId: party.channelId ?? party.id,
    pageUrl: party.formUrl,
    fingerprint: submissionFingerprint(lostCase, resolved),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    submitAllowed: party.submissionMode === "adapter" && Boolean(party.adapterId),
    adapterId: party.adapterId,
    formContentHash: party.formContentHash,
    fields,
    manualRequiredFields,
  };
}
