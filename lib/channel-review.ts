import type {
  ChannelCandidate,
  ReviewDecision,
} from "../scripts/lost-found-crawler/schemas";

export const AUTOMATED_REVIEW_POLICY_VERSION =
  "deepseek-official-contact-fallback-v4";

const ACCEPTED_AUTOMATED_REVIEW_POLICY_VERSIONS = new Set([
  "deepseek-lost-property-bound-v2",
  "deepseek-official-contact-fallback-v3",
  AUTOMATED_REVIEW_POLICY_VERSION,
]);

export function automatedReviewAttestationIsCurrent(
  decision: ReviewDecision
): boolean {
  const audit = decision.automatedAudit;
  let finalUrl: URL | undefined;
  try {
    finalUrl = audit ? new URL(audit.finalUrl) : undefined;
  } catch {
    finalUrl = undefined;
  }
  return Boolean(
    decision.reviewerKind === "automated" &&
      audit &&
      audit.method === "source_grounded_model" &&
      ACCEPTED_AUTOMATED_REVIEW_POLICY_VERSIONS.has(audit.policyVersion) &&
      audit.model.trim() &&
      /^[a-f0-9]{64}$/.test(audit.sourceHash) &&
      /^[a-f0-9]{64}$/.test(audit.evidenceQuoteHash) &&
      finalUrl &&
      ["http:", "https:"].includes(finalUrl.protocol)
  );
}

export type ReviewAction = ReviewDecision["decision"] | "clear";

export interface ReviewWriteInput {
  candidateId: string;
  decision: ReviewAction;
  notes?: string;
  submissionMode?: ReviewDecision["submissionMode"];
}

export function candidateReviewVersion(candidate: ChannelCandidate): string {
  return JSON.stringify({
    id: candidate.id,
    operatorId: candidate.operatorId ?? null,
    venueIds: [...candidate.venueIds].sort(),
    kind: candidate.kind,
    pageUrl: candidate.pageUrl,
    contactValue: candidate.contactValue ?? null,
    formContentHash: candidate.form?.contentHash ?? null,
    evidenceHashes: candidate.evidence
      .map((evidence) => evidence.contentHash)
      .sort(),
  });
}

function reviewTimestamp(value: string): number {
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value;
  return Date.parse(normalized);
}

export function reviewEventIsNewer(
  current: ReviewDecision | undefined,
  eventUpdatedAt: string
): boolean {
  if (!current) return true;
  const eventTime = reviewTimestamp(eventUpdatedAt);
  const currentTime = reviewTimestamp(current.reviewedAt);
  return (
    Number.isFinite(eventTime) &&
    (!Number.isFinite(currentTime) || eventTime >= currentTime)
  );
}

export function createReviewDecision(input: {
  candidate: ChannelCandidate;
  decision: Exclude<ReviewAction, "clear">;
  reviewerName: string;
  notes?: string;
  submissionMode?: ReviewDecision["submissionMode"];
  reviewedAt?: string;
}): ReviewDecision {
  const reviewerName = input.reviewerName.trim();
  if (!reviewerName) throw new Error("Reviewer identity is required.");

  const notes = input.notes?.trim().slice(0, 1000) || undefined;
  if (input.decision === "reject") {
    return {
      candidateId: input.candidate.id,
      decision: "reject",
      reviewedAt: input.reviewedAt ?? new Date().toISOString(),
      reviewedBy: reviewerName,
      reviewerKind: "human",
      reviewedCandidateVersion: candidateReviewVersion(input.candidate),
      notes,
    };
  }

  if (input.candidate.kind === "manual_review") {
    throw new Error(
      "Evidence-only pages cannot be accepted without a publishable channel."
    );
  }
  if (
    input.candidate.canonicalizationStatus === "pending" ||
    input.candidate.venueIds.length === 0
  ) {
    throw new Error(
      "This Google-discovered destination must be mapped to an open venue ID before it can be accepted."
    );
  }
  const submissionMode = input.submissionMode ?? "open_only";
  if (
    submissionMode !== "open_only" &&
    submissionMode !== "assisted_fill" &&
    submissionMode !== "adapter"
  ) {
    throw new Error("Unsupported submission mode.");
  }
  if (
    (submissionMode === "assisted_fill" || submissionMode === "adapter") &&
    !input.candidate.form?.fields.length
  ) {
    throw new Error(
      "Assisted filling requires currently extracted form fields."
    );
  }
  if (submissionMode === "adapter") {
    throw new Error(
      "Submission adapters must be approved through the tested adapter workflow."
    );
  }

  return {
    candidateId: input.candidate.id,
    decision: "accept",
    reviewedAt: input.reviewedAt ?? new Date().toISOString(),
    reviewedBy: reviewerName,
    reviewerKind: "human",
    reviewedCandidateVersion: candidateReviewVersion(input.candidate),
    notes,
    kindOverride: input.candidate.kind,
    submissionMode,
    reviewedContentHash:
      submissionMode === "assisted_fill"
        ? input.candidate.form?.contentHash
        : undefined,
  };
}
