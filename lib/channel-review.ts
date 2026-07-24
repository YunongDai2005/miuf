import type {
  ChannelCandidate,
  ReviewDecision,
} from "../scripts/lost-found-crawler/schemas";

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
      reviewedCandidateVersion: candidateReviewVersion(input.candidate),
      notes,
    };
  }

  if (input.candidate.kind === "manual_review") {
    throw new Error(
      "Evidence-only pages cannot be accepted without a publishable channel."
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
