import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  automatedReviewAttestationIsCurrent,
  candidateReviewVersion,
} from "../../lib/channel-review";
import type {
  CandidateFile,
  ChannelCandidate,
  ReviewDecision,
  ReviewFile,
} from "./schemas";

export type ReviewMaintenanceReason =
  | "missing_candidate"
  | "candidate_changed"
  | "legacy_or_ungrounded_acceptance";

export function acceptanceQuarantineReason(
  decision: ReviewDecision,
  candidate: ChannelCandidate | undefined
): ReviewMaintenanceReason | undefined {
  if (decision.decision !== "accept") return undefined;
  if (!candidate) return "missing_candidate";
  if (decision.reviewedCandidateVersion !== candidateReviewVersion(candidate)) {
    return "candidate_changed";
  }
  if (decision.reviewerKind === "human") return undefined;
  if (automatedReviewAttestationIsCurrent(decision)) return undefined;
  return "legacy_or_ungrounded_acceptance";
}

export function reviewQuarantineReason(
  decision: ReviewDecision,
  candidate: ChannelCandidate | undefined
): ReviewMaintenanceReason | undefined {
  if (!candidate) return "missing_candidate";
  if (decision.reviewedCandidateVersion !== candidateReviewVersion(candidate)) {
    return "candidate_changed";
  }
  return acceptanceQuarantineReason(decision, candidate);
}

export async function sanitizeReviewFile(options: {
  candidatePath: string;
  reviewPath: string;
  quarantinePath: string;
  apply?: boolean;
  now?: Date;
}): Promise<{
  total: number;
  retained: number;
  retainedAcceptances: number;
  quarantinedDecisions: number;
  quarantinedAcceptances: number;
  reasonCounts: Record<ReviewMaintenanceReason, number>;
  applied: boolean;
}> {
  const candidates = JSON.parse(
    await readFile(options.candidatePath, "utf8")
  ) as CandidateFile;
  const reviews = JSON.parse(
    await readFile(options.reviewPath, "utf8")
  ) as ReviewFile;
  if (candidates.version !== 1 || reviews.version !== 1) {
    throw new Error("Unsupported candidate or review file version");
  }
  const candidatesById = new Map(
    candidates.candidates.map((candidate) => [candidate.id, candidate])
  );
  const latestDecisions = new Map<string, ReviewDecision>();
  for (const decision of reviews.decisions) {
    const existing = latestDecisions.get(decision.candidateId);
    if (!existing || decision.reviewedAt >= existing.reviewedAt) {
      latestDecisions.set(decision.candidateId, decision);
    }
  }
  const retained: ReviewDecision[] = [];
  const quarantined: Array<{
    reason: ReviewMaintenanceReason;
    decision: ReviewDecision;
  }> = [];
  for (const decision of latestDecisions.values()) {
    const reason = reviewQuarantineReason(
      decision,
      candidatesById.get(decision.candidateId)
    );
    if (reason) quarantined.push({ reason, decision });
    else retained.push(decision);
  }
  const reasons: ReviewMaintenanceReason[] = [
    "missing_candidate",
    "candidate_changed",
    "legacy_or_ungrounded_acceptance",
  ];
  const result = {
    total: latestDecisions.size,
    retained: retained.length,
    retainedAcceptances: retained.filter(
      (decision) => decision.decision === "accept"
    ).length,
    quarantinedDecisions: quarantined.length,
    quarantinedAcceptances: quarantined.filter(
      (entry) => entry.decision.decision === "accept"
    ).length,
    reasonCounts: Object.fromEntries(
      reasons.map((reason) => [
        reason,
        quarantined.filter((entry) => entry.reason === reason).length,
      ])
    ) as Record<ReviewMaintenanceReason, number>,
    applied: Boolean(options.apply),
  };
  if (!options.apply) return result;

  const generatedAt = (options.now ?? new Date()).toISOString();
  let previousEntries: typeof quarantined = [];
  try {
    const previous = JSON.parse(
      await readFile(options.quarantinePath, "utf8")
    ) as { entries?: typeof quarantined };
    if (Array.isArray(previous.entries)) previousEntries = previous.entries;
  } catch {
    // The first sanitation pass has no previous quarantine file.
  }
  const quarantineEntries = new Map<string, (typeof quarantined)[number]>();
  for (const entry of [...previousEntries, ...quarantined]) {
    quarantineEntries.set(
      `${entry.reason}\0${entry.decision.candidateId}\0${entry.decision.reviewedAt}`,
      entry
    );
  }
  const quarantine = {
    version: 1,
    generatedAt,
    sourceReviewPath: options.reviewPath,
    entries: [...quarantineEntries.values()].sort(
      (left, right) =>
        left.decision.candidateId.localeCompare(right.decision.candidateId) ||
        left.decision.reviewedAt.localeCompare(right.decision.reviewedAt)
    ),
  };
  const safeReviews: ReviewFile = {
    version: 1,
    decisions: retained.sort(
      (left, right) =>
        left.candidateId.localeCompare(right.candidateId) ||
        left.reviewedAt.localeCompare(right.reviewedAt)
    ),
  };
  await mkdir(dirname(options.quarantinePath), { recursive: true });
  await writeFile(
    options.quarantinePath,
    `${JSON.stringify(quarantine, null, 2)}\n`
  );
  const temporaryPath = `${options.reviewPath}.tmp-${process.pid}`;
  await writeFile(temporaryPath, `${JSON.stringify(safeReviews, null, 2)}\n`);
  await rename(temporaryPath, options.reviewPath);
  return result;
}
