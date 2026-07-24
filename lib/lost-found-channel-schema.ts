export const CHANNEL_REGISTRY_VERSION = 1 as const;

export type SemanticField =
  | "lossDate"
  | "lossTime"
  | "lossLocation"
  | "lossLocationType"
  | "lossCityOrPostalCode"
  | "venue"
  | "transitLine"
  | "boardingStop"
  | "alightingStop"
  | "direction"
  | "itemCategory"
  | "itemDescription"
  | "messageBody"
  | "brand"
  | "color"
  | "identifyingFeatures"
  | "estimatedValue"
  | "firstName"
  | "lastName"
  | "fullName"
  | "email"
  | "phone"
  | "postalAddress"
  | "attachment"
  | "privacyConsent"
  | "other";

export type FormControl =
  | "text"
  | "textarea"
  | "date"
  | "time"
  | "number"
  | "email"
  | "tel"
  | "radio"
  | "checkbox"
  | "select"
  | "file"
  | "hidden"
  | "custom";

export interface FieldConstraint {
  pattern?: string;
  min?: string;
  max?: string;
  minLength?: number;
  maxLength?: number;
  acceptedFiles?: string[];
}

export interface ChannelField {
  rawName?: string;
  rawId?: string;
  label: string;
  helpText?: string;
  placeholder?: string;
  control: FormControl;
  required: boolean;
  options?: Array<{ value: string; label: string }>;
  constraints?: FieldConstraint;
  step: number;
  semanticKey: SemanticField;
  semanticConfidence: number;
  evidenceSelector: string;
}

export type ChannelKind =
  | "dedicated_lost_found_form"
  | "operator_lost_found_form"
  | "general_contact_form"
  | "email"
  | "phone"
  | "central_office_fallback";

export interface ClaimEvidence {
  sourceUrl: string;
  selector?: string;
  excerpt?: string;
  contentHash: string;
  observedAt: string;
}

export interface PublishedLostFoundChannel {
  id: string;
  operatorId?: string;
  venueIds: string[];
  kind: ChannelKind;
  scope: "venue" | "operator" | "city";
  pageUrl: string;
  /** Reviewed public address for email/phone channels. */
  contactValue?: string;
  formAction?: string;
  formMethod?: "GET" | "POST";
  language: string[];
  fields: ChannelField[];
  captcha: boolean;
  loginRequired: boolean;
  submissionMode: "open_only" | "assisted_fill" | "adapter";
  adapterId?: string;
  verifiedAt: string;
  /** Human re-review deadline. Automated checks do not silently extend it. */
  reviewDueAt?: string;
  verifiedBy: string;
  evidence: ClaimEvidence[];
  contentHash: string;
}

export interface SubmissionAdapter {
  id: string;
  channelId: string;
  origin: string;
  pathPattern: string;
  testedContentHash: string;
  submitSelector: string;
  successSelector?: string;
  successText?: string;
  receiptSelector?: string;
}

export interface PublishedChannelRegistry {
  version: typeof CHANNEL_REGISTRY_VERSION;
  generatedAt: string;
  channels: PublishedLostFoundChannel[];
}

const CHANNEL_KINDS = new Set<ChannelKind>([
  "dedicated_lost_found_form",
  "operator_lost_found_form",
  "general_contact_form",
  "email",
  "phone",
  "central_office_fallback",
]);
const SUBMISSION_MODES = new Set<PublishedLostFoundChannel["submissionMode"]>([
  "open_only",
  "assisted_fill",
  "adapter",
]);
const FORM_CONTROLS = new Set<FormControl>([
  "text",
  "textarea",
  "date",
  "time",
  "number",
  "email",
  "tel",
  "radio",
  "checkbox",
  "select",
  "file",
  "hidden",
  "custom",
]);
const SEMANTIC_FIELDS = new Set<SemanticField>([
  "lossDate",
  "lossTime",
  "lossLocation",
  "lossLocationType",
  "lossCityOrPostalCode",
  "venue",
  "transitLine",
  "boardingStop",
  "alightingStop",
  "direction",
  "itemCategory",
  "itemDescription",
  "messageBody",
  "brand",
  "color",
  "identifyingFeatures",
  "estimatedValue",
  "firstName",
  "lastName",
  "fullName",
  "email",
  "phone",
  "postalAddress",
  "attachment",
  "privacyConsent",
  "other",
]);

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isChannelField(value: unknown): value is ChannelField {
  if (!value || typeof value !== "object") return false;
  const field = value as Partial<ChannelField>;
  return (
    typeof field.label === "string" &&
    field.label.length > 0 &&
    FORM_CONTROLS.has(field.control as FormControl) &&
    typeof field.required === "boolean" &&
    typeof field.step === "number" &&
    Number.isInteger(field.step) &&
    field.step >= 1 &&
    SEMANTIC_FIELDS.has(field.semanticKey as SemanticField) &&
    typeof field.semanticConfidence === "number" &&
    field.semanticConfidence >= 0 &&
    field.semanticConfidence <= 1 &&
    typeof field.evidenceSelector === "string" &&
    field.evidenceSelector.length > 0
  );
}

function isClaimEvidence(value: unknown): value is ClaimEvidence {
  if (!value || typeof value !== "object") return false;
  const evidence = value as Partial<ClaimEvidence>;
  return (
    isHttpUrl(evidence.sourceUrl) &&
    typeof evidence.contentHash === "string" &&
    evidence.contentHash.length > 0 &&
    typeof evidence.observedAt === "string" &&
    Number.isFinite(Date.parse(evidence.observedAt))
  );
}

export function isChannelReviewCurrent(
  channel: Pick<PublishedLostFoundChannel, "verifiedAt" | "reviewDueAt">,
  now = new Date()
): boolean {
  const verified = Date.parse(channel.verifiedAt);
  if (!Number.isFinite(verified)) return false;
  const due = channel.reviewDueAt
    ? Date.parse(channel.reviewDueAt)
    : verified + 90 * 24 * 60 * 60 * 1000;
  return Number.isFinite(due) && now.getTime() <= due;
}

export function isPublishedLostFoundChannel(
  value: unknown
): value is PublishedLostFoundChannel {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<PublishedLostFoundChannel>;
  return (
    typeof candidate.id === "string" &&
    candidate.id.length > 0 &&
    Array.isArray(candidate.venueIds) &&
    candidate.venueIds.every((id) => typeof id === "string") &&
    CHANNEL_KINDS.has(candidate.kind as ChannelKind) &&
    (candidate.scope === "venue" ||
      candidate.scope === "operator" ||
      candidate.scope === "city") &&
    isHttpUrl(candidate.pageUrl) &&
    ((candidate.kind !== "email" && candidate.kind !== "phone") ||
      (typeof candidate.contactValue === "string" &&
        candidate.contactValue.trim().length > 0)) &&
    (candidate.formAction === undefined || isHttpUrl(candidate.formAction)) &&
    Array.isArray(candidate.language) &&
    candidate.language.every((language) => typeof language === "string") &&
    Array.isArray(candidate.fields) &&
    candidate.fields.every(isChannelField) &&
    typeof candidate.captcha === "boolean" &&
    typeof candidate.loginRequired === "boolean" &&
    SUBMISSION_MODES.has(
      candidate.submissionMode as PublishedLostFoundChannel["submissionMode"]
    ) &&
    (candidate.submissionMode !== "adapter" ||
      (typeof candidate.adapterId === "string" && candidate.adapterId.length > 0)) &&
    typeof candidate.verifiedAt === "string" &&
    Number.isFinite(Date.parse(candidate.verifiedAt)) &&
    (candidate.reviewDueAt === undefined ||
      Number.isFinite(Date.parse(candidate.reviewDueAt))) &&
    typeof candidate.verifiedBy === "string" &&
    candidate.verifiedBy.length > 0 &&
    Array.isArray(candidate.evidence) &&
    candidate.evidence.length > 0 &&
    candidate.evidence.every(isClaimEvidence) &&
    typeof candidate.contentHash === "string" &&
    candidate.contentHash.length > 0
  );
}

export function isPublishedChannelRegistry(
  value: unknown
): value is PublishedChannelRegistry {
  if (!value || typeof value !== "object") return false;
  const registry = value as Partial<PublishedChannelRegistry>;
  if (
    registry.version !== CHANNEL_REGISTRY_VERSION ||
    typeof registry.generatedAt !== "string" ||
    !Array.isArray(registry.channels)
  ) {
    return false;
  }
  return registry.channels.every(isPublishedLostFoundChannel);
}
