import type { ChannelKind } from "../../lib/lost-found-channel-schema";
import type { FormSnapshot } from "./schemas";

const LOST_PATTERN =
  /fundbüro|fundbuero|fundsache|verlustmeldung|gegenstand verloren|lost property|lost and found|report.{0,20}lost/i;
const CONTACT_PATTERN = /\bkontakt|contact|besucherservice|visitor service\b/i;

export function scoreCandidate(input: {
  url: string;
  title: string;
  text: string;
  form?: FormSnapshot;
  linkedFromOfficialSeed: boolean;
}): { confidence: number; kind: ChannelKind | "manual_review"; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const searchable = `${input.url} ${input.title} ${input.text.slice(0, 8_000)}`;
  if (input.linkedFromOfficialSeed) {
    score += 20;
    reasons.push("linked from the official seed site");
  }
  if (LOST_PATTERN.test(searchable)) {
    score += 35;
    reasons.push("page explicitly mentions lost property");
  }
  const semanticKeys = new Set<string>(
    input.form?.fields.map((field) => field.semanticKey) ?? []
  );
  const lostSpecificFields = [
    "lossDate",
    "lossTime",
    "lossLocation",
    "itemCategory",
    "itemDescription",
  ].filter((key) => semanticKeys.has(key)).length;
  if (lostSpecificFields >= 2) {
    score += 30;
    reasons.push(`form contains ${lostSpecificFields} lost-item fields`);
  } else if (input.form) {
    score += 10;
    reasons.push("page contains a form");
  }
  if (input.form?.captcha) {
    reasons.push("CAPTCHA requires user interaction");
  }
  if (input.form?.loginRequired) {
    score -= 20;
    reasons.push("login appears to be required");
  }
  if (
    input.form &&
    CONTACT_PATTERN.test(searchable) &&
    !LOST_PATTERN.test(searchable)
  ) {
    return {
      confidence: Math.min(score, 60),
      kind: "general_contact_form",
      reasons,
    };
  }
  const confidence = Math.max(0, Math.min(100, score));
  return {
    confidence,
    kind:
      confidence >= 70 && input.form
        ? "dedicated_lost_found_form"
        : "manual_review",
    reasons,
  };
}
