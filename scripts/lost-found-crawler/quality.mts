import { readFile } from "node:fs/promises";
import type { PublishedChannelRegistry } from "../../lib/lost-found-channel-schema";
import { isChannelReviewCurrent } from "../../lib/lost-found-channel-schema";
import { candidateReviewVersion } from "../../lib/channel-review";
import {
  buildDiscoverySeedGroups,
  candidateUrlIdentity,
  discoveryScopeId,
} from "./discovery.mjs";
import { candidateEndpointIdentity } from "./merge.mjs";
import { acceptanceQuarantineReason } from "./review-maintenance.mjs";
import type { CandidateFile, InventoryFile, ReviewFile } from "./schemas";

export async function auditLostFoundPipeline(options: {
  inventoryPath: string;
  candidatePath: string;
  reviewPath: string;
  registryPath: string;
}) {
  const [inventory, candidates, reviews, registry] = await Promise.all([
    readFile(options.inventoryPath, "utf8").then(
      (value) => JSON.parse(value) as InventoryFile
    ),
    readFile(options.candidatePath, "utf8").then(
      (value) => JSON.parse(value) as CandidateFile
    ),
    readFile(options.reviewPath, "utf8").then(
      (value) => JSON.parse(value) as ReviewFile
    ),
    readFile(options.registryPath, "utf8").then(
      (value) => JSON.parse(value) as PublishedChannelRegistry
    ),
  ]);
  if (
    inventory.version !== 1 ||
    candidates.version !== 1 ||
    reviews.version !== 1 ||
    registry.version !== 1
  ) {
    throw new Error("Unsupported pipeline artifact version");
  }
  const candidatesById = new Map(
    candidates.candidates.map((candidate) => [candidate.id, candidate])
  );
  const latestDecisions = new Map(
    reviews.decisions.map((decision) => [decision.candidateId, decision])
  );
  const accepted = [...latestDecisions.values()].filter(
    (decision) => decision.decision === "accept"
  );
  const invalidAcceptances = accepted.filter((decision) =>
    acceptanceQuarantineReason(
      decision,
      candidatesById.get(decision.candidateId)
    )
  );
  const joiningDecisions = [...latestDecisions.values()].filter((decision) => {
    const candidate = candidatesById.get(decision.candidateId);
    return (
      candidate &&
      decision.reviewedCandidateVersion === candidateReviewVersion(candidate)
    );
  });
  const seedGroups = buildDiscoverySeedGroups(inventory);
  const currentScopeIds = new Set(
    seedGroups.map(discoveryScopeId)
  );
  const currentCheckpoints = (candidates.completedScopes ?? []).filter(
    (checkpoint) => currentScopeIds.has(checkpoint.scopeId)
  );
  const pageCandidateCounts = new Map<string, number>();
  const contactCandidates = candidates.candidates.filter(
    (candidate) =>
      (candidate.kind === "email" || candidate.kind === "phone") &&
      Boolean(candidate.contactValue)
  );
  const lostPurpose =
    /lost[\s-]*(?:and[\s-]*found|property|item)|fund(?:b(?:ü|u|ue)ro|sache|stelle)|verlustsache|verloren(?:e|en)?\s+gegenst/iu;
  const purposeBoundContacts = contactCandidates.filter((candidate) =>
    candidate.evidence.some((evidence) => {
      const excerpt = evidence.excerpt ?? "";
      if (!lostPurpose.test(excerpt)) return false;
      const value = candidate.contactValue ?? "";
      return candidate.kind === "phone"
        ? excerpt.replace(/\D/g, "").includes(value.replace(/\D/g, ""))
        : excerpt.toLowerCase().includes(value.toLowerCase());
    })
  );
  for (const candidate of candidates.candidates) {
    const page = candidateUrlIdentity(candidate.pageUrl);
    pageCandidateCounts.set(page, (pageCandidateCounts.get(page) ?? 0) + 1);
  }
  const noisyPages = [...pageCandidateCounts.entries()]
    .filter(([, count]) => count > 10)
    .sort((left, right) => right[1] - left[1]);
  const expiredPublishedChannels = registry.channels.filter(
    (channel) => !isChannelReviewCurrent(channel)
  ).length;
  const warnings: string[] = [];
  const errors: string[] = [];
  const orphanDecisions = latestDecisions.size - joiningDecisions.length;
  if (orphanDecisions > 0) {
    warnings.push(
      `${orphanDecisions} review decision(s) refer to missing or changed candidates.`
    );
  }
  if (currentCheckpoints.length < (candidates.completedScopes?.length ?? 0)) {
    warnings.push(
      `${(candidates.completedScopes?.length ?? 0) - currentCheckpoints.length} crawl checkpoint(s) no longer match the current inventory.`
    );
  }
  if (noisyPages.length > 0) {
    warnings.push(
      `${noisyPages.length} page(s) generated more than 10 candidates and need directory-noise review.`
    );
  }
  if (
    contactCandidates.length > 0 &&
    purposeBoundContacts.length / contactCandidates.length < 0.5
  ) {
    warnings.push(
      `Only ${purposeBoundContacts.length}/${contactCandidates.length} contact candidate(s) have locally bound lost-property evidence; regenerate candidates with the current extractor before bulk review.`
    );
  }
  if (expiredPublishedChannels > 0) {
    errors.push(
      `${expiredPublishedChannels} published channel(s) are past their review deadline.`
    );
  }
  if (invalidAcceptances.length > 0) {
    errors.push(
      `${invalidAcceptances.length} accepted decision(s) are not currently publishable.`
    );
  }
  const endpointCounts = new Map<string, number>();
  for (const candidate of candidates.candidates) {
    const identity = candidateEndpointIdentity(candidate);
    endpointCounts.set(identity, (endpointCounts.get(identity) ?? 0) + 1);
  }
  return {
    generatedAt: new Date().toISOString(),
    inventory: {
      venues: inventory.venues.length,
      officialWebsiteSeeds: inventory.summary.officialWebsites,
      operatorSeeds: inventory.operators.length,
    },
    discovery: {
      candidates: candidates.candidates.length,
      uniquePages: new Set(
        candidates.candidates.map((candidate) =>
          candidateUrlIdentity(candidate.pageUrl)
        )
      ).size,
      uniqueEndpoints: endpointCounts.size,
      duplicateEndpointRows: [...endpointCounts.values()].reduce(
        (total, count) => total + Math.max(0, count - 1),
        0
      ),
      completedScopes: candidates.completedScopes?.length ?? 0,
      currentScopeGroups: seedGroups.length,
      currentCompletedScopes: currentCheckpoints.length,
      effectiveCompletionRate:
        seedGroups.length > 0
          ? Number((currentCheckpoints.length / seedGroups.length).toFixed(4))
          : 0,
      noisyPages: noisyPages.slice(0, 20).map(([pageUrl, count]) => ({
        pageUrl,
        candidates: count,
      })),
      pendingCanonicalization: candidates.candidates.filter(
        (candidate) => candidate.canonicalizationStatus === "pending"
      ).length,
      contactCandidates: contactCandidates.length,
      purposeBoundContactCandidates: purposeBoundContacts.length,
    },
    review: {
      decisions: latestDecisions.size,
      decisionsJoiningCurrentCandidates: joiningDecisions.length,
      orphanDecisions,
      accepted: accepted.length,
      publishableAcceptances: accepted.length - invalidAcceptances.length,
      quarantinableAcceptances: invalidAcceptances.length,
      rejected: [...latestDecisions.values()].filter(
        (decision) => decision.decision === "reject"
      ).length,
    },
    published: {
      channels: registry.channels.length,
      coveredVenues: new Set(
        registry.channels.flatMap((channel) => channel.venueIds)
      ).size,
      uniqueEndpoints: new Set(
        registry.channels.map((channel) =>
          [
            channel.kind,
            candidateUrlIdentity(channel.pageUrl),
            channel.contactValue ?? channel.formAction ?? "",
          ].join("\0")
        )
      ).size,
      expiredChannels: expiredPublishedChannels,
    },
    health: {
      ok: errors.length === 0,
      errors,
      warnings,
    },
  };
}
