import { buildReportDrafts, reportBodyForParty } from "./report";
import type { ResolvedParty } from "./parties";
import type {
  LostCase,
  SubmissionOutcomePackage,
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
    body: reportBodyForParty(drafts, resolved),
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

export function submissionRecordFromOutcome(
  value: unknown,
  expected: {
    partyId: string;
    channelId: string;
    fingerprint: string;
  }
): SubmissionRecord {
  if (!value || typeof value !== "object") {
    throw new Error("The helper result is not a valid package.");
  }
  const outcome = value as Partial<SubmissionOutcomePackage>;
  if (
    outcome.version !== 1 ||
    outcome.channelId !== expected.channelId ||
    outcome.fingerprint !== expected.fingerprint
  ) {
    throw new Error("This helper result belongs to a different report.");
  }
  if (
    outcome.status !== "user_confirmed" &&
    outcome.status !== "receipt_confirmed" &&
    outcome.status !== "uncertain"
  ) {
    throw new Error("The helper result has an unsupported status.");
  }
  const updatedAt = Date.parse(outcome.updatedAt ?? "");
  if (
    !Number.isFinite(updatedAt) ||
    updatedAt > Date.now() + 5 * 60 * 1000
  ) {
    throw new Error("The helper result has an invalid time.");
  }
  const receipt =
    typeof outcome.receipt === "string"
      ? outcome.receipt.trim().slice(0, 500)
      : undefined;
  if (outcome.status === "receipt_confirmed" && !receipt) {
    throw new Error("The helper result says a receipt exists but does not include it.");
  }
  return {
    partyId: expected.partyId,
    fingerprint: expected.fingerprint,
    status: outcome.status,
    updatedAt: new Date(updatedAt).toISOString(),
    receipt: receipt || undefined,
  };
}
