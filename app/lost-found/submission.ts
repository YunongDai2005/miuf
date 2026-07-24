import { buildReportDrafts } from "./report";
import type { ResolvedParty } from "./parties";
import type {
  LostCase,
  SubmissionRecord,
  SubmissionStatus,
} from "./types";

function fnv1a(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function submissionFingerprint(
  lostCase: LostCase,
  resolved: ResolvedParty
): string {
  const drafts = buildReportDrafts(lostCase, resolved);
  const canonical = JSON.stringify({
    partyId: resolved.party.id,
    destination: resolved.party.formUrl ?? resolved.party.email ?? resolved.party.website,
    subject: drafts.subject,
    body: drafts.de,
  });
  return `${fnv1a(canonical, 0x811c9dc5)}${fnv1a(canonical, 0x9e3779b9)}`;
}

export function nextSubmissionRecord(input: {
  partyId: string;
  fingerprint: string;
  status: SubmissionStatus;
  receipt?: string;
  now?: Date;
}): SubmissionRecord {
  return {
    partyId: input.partyId,
    fingerprint: input.fingerprint,
    status: input.status,
    updatedAt: (input.now ?? new Date()).toISOString(),
    receipt: input.receipt?.trim() || undefined,
  };
}
