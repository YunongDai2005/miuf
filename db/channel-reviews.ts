import { sql } from "drizzle-orm";
import {
  candidateReviewVersion,
  reviewEventIsNewer,
} from "../lib/channel-review";
import type {
  ChannelCandidate,
  ReviewDecision,
} from "../scripts/lost-found-crawler/schemas";
import { getDb } from ".";
import { channelReviewCurrent, channelReviewEvents } from "./schema";

function parseDecision(
  value: string | null,
  candidate: ChannelCandidate
): ReviewDecision | null {
  if (!value) return null;
  try {
    const decision = JSON.parse(value) as Partial<ReviewDecision>;
    if (
      decision.candidateId !== candidate.id ||
      (decision.decision !== "accept" && decision.decision !== "reject") ||
      typeof decision.reviewedAt !== "string" ||
      !Number.isFinite(Date.parse(decision.reviewedAt)) ||
      typeof decision.reviewedBy !== "string" ||
      !decision.reviewedBy.trim() ||
      decision.reviewedCandidateVersion !== candidateReviewVersion(candidate)
    ) {
      return null;
    }
    return decision as ReviewDecision;
  } catch {
    return null;
  }
}

export async function readCurrentReviewDecisions(
  candidates: ChannelCandidate[],
  baseline: ReviewDecision[] = []
): Promise<ReviewDecision[]> {
  const rows = await getDb()
    .select()
    .from(channelReviewCurrent);
  const candidatesById = new Map(
    candidates.map((candidate) => [candidate.id, candidate])
  );
  const decisions = new Map<string, ReviewDecision>();

  for (const decision of baseline) {
    const candidate = candidatesById.get(decision.candidateId);
    if (
      candidate &&
      decision.reviewedCandidateVersion === candidateReviewVersion(candidate)
    ) {
      const parsed = parseDecision(JSON.stringify(decision), candidate);
      if (parsed) decisions.set(candidate.id, parsed);
    }
  }

  for (const row of rows) {
    const candidate = candidatesById.get(row.candidateId);
    if (
      !candidate ||
      row.candidateVersion !== candidateReviewVersion(candidate)
    ) {
      continue;
    }
    if (
      !reviewEventIsNewer(
        decisions.get(candidate.id),
        row.updatedAt
      )
    ) {
      continue;
    }
    if (row.action === "clear") {
      decisions.delete(candidate.id);
      continue;
    }
    const decision = parseDecision(row.decisionJson, candidate);
    if (decision && decision.decision === row.action) {
      decisions.set(candidate.id, decision);
    }
  }

  return [...decisions.values()].sort((left, right) =>
    left.candidateId.localeCompare(right.candidateId)
  );
}

export async function appendReviewEvent(input: {
  candidate: ChannelCandidate;
  action: "accept" | "reject" | "clear";
  reviewerEmail: string;
  decision?: ReviewDecision;
}): Promise<void> {
  const db = getDb();
  const candidateVersion = candidateReviewVersion(input.candidate);
  const decisionJson = input.decision
    ? JSON.stringify(input.decision)
    : null;
  const event = db.insert(channelReviewEvents).values({
    candidateId: input.candidate.id,
    candidateVersion,
    action: input.action,
    decisionJson,
    reviewerEmail: input.reviewerEmail,
  });
  const current = db
    .insert(channelReviewCurrent)
    .values({
      candidateId: input.candidate.id,
      candidateVersion,
      action: input.action,
      decisionJson,
      reviewerEmail: input.reviewerEmail,
    })
    .onConflictDoUpdate({
      target: channelReviewCurrent.candidateId,
      set: {
        candidateVersion,
        action: input.action,
        decisionJson,
        reviewerEmail: input.reviewerEmail,
        updatedAt: sql`CURRENT_TIMESTAMP`,
      },
    });
  await db.batch([event, current]);
}
