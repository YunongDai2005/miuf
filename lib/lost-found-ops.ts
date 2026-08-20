import { candidateReviewVersion } from "./channel-review";
import type { PublishedChannelRegistry } from "./lost-found-channel-schema";
import type {
  CandidateFile,
  InventoryFile,
  ReviewFile,
} from "../scripts/lost-found-crawler/schemas";

export type OpsSeverity = "critical" | "high" | "medium" | "low";
export type OpsStageStatus = "healthy" | "warning" | "blocked";

export interface PipelineQualitySnapshot {
  generatedAt: string;
  inventory: {
    venues: number;
    officialWebsiteSeeds: number;
    operatorSeeds: number;
  };
  discovery: {
    candidates: number;
    uniquePages: number;
    uniqueEndpoints: number;
    completedScopes: number;
    currentScopeGroups: number;
    currentCompletedScopes: number;
    effectiveCompletionRate: number;
    pendingCanonicalization: number;
    contactCandidates: number;
    purposeBoundContactCandidates: number;
    noisyPages: Array<{ pageUrl: string; candidates: number }>;
  };
  review: {
    decisions: number;
    decisionsJoiningCurrentCandidates: number;
    orphanDecisions: number;
    accepted: number;
    publishableAcceptances: number;
    quarantinableAcceptances: number;
    rejected: number;
  };
  published: {
    channels: number;
    coveredVenues: number;
    uniqueEndpoints: number;
    expiredChannels: number;
  };
  health: { ok: boolean; errors: string[]; warnings: string[] };
}

export interface CoverageSnapshot {
  generatedAt: string;
  summary: {
    totalVenues: number;
    reviewedChannel: number;
    officialContact: number;
    parentCandidate: number;
    manualGuidance: number;
    addressableVenues: number;
    addressableWithRoute: number;
    addressableRouteRate: number;
  };
  tiers: Array<{ id: string; label: string; count: number }>;
}

interface ReviewQuarantineSnapshot {
  generatedAt?: string;
  entries?: Array<{ reason: string }>;
}

export interface OpsIssue {
  id: string;
  severity: OpsSeverity;
  title: string;
  evidence: string;
  action: string;
}

export interface OpsStage {
  id: string;
  label: string;
  status: OpsStageStatus;
  value: string;
  detail: string;
}

export interface OpsBatchTarget {
  domain: string;
  candidates: number;
  pages: number;
  contacts: number;
  needsReview: number;
  pendingCanonicalization: number;
  reason: string;
}

export interface OpsDashboardSnapshot {
  generatedAt: string;
  overallStatus: OpsStageStatus;
  headline: {
    totalVenues: number;
    crawlCompleted: number;
    crawlTotal: number;
    crawlRate: number;
    candidates: number;
    currentAcceptances: number;
    publishedChannels: number;
    coveredVenues: number;
    officialSourceFallbackVenues: number;
    directContactFallbackCandidateVenues: number;
  };
  stages: OpsStage[];
  candidateMix: Array<{ id: string; label: string; value: number }>;
  reviewMix: Array<{ id: string; label: string; value: number }>;
  coverage: {
    addressableVenues: number;
    addressableWithRoute: number;
    addressableRouteRate: number;
    tiers: Array<{ id: string; label: string; value: number }>;
  };
  sources: Array<{ label: string; generatedAt: string; records: number }>;
  issues: OpsIssue[];
  batchTargets: OpsBatchTarget[];
  quarantinedDecisions: number;
}

const LOST_PURPOSE =
  /lost[\s-]*(?:and[\s-]*found|property|item)|fund(?:b(?:ü|u|ue)ro|sache|stelle)|verlustsache|etwas\s+(?:verloren|gefunden)/iu;

function contactEvidenceIsBound(
  candidate: CandidateFile["candidates"][number]
): boolean {
  const value = candidate.contactValue;
  if (!value) return false;
  return candidate.evidence.some((evidence) => {
    const excerpt = evidence.excerpt ?? "";
    if (!LOST_PURPOSE.test(excerpt)) return false;
    return candidate.kind === "phone"
      ? excerpt.replace(/\D/g, "").includes(value.replace(/\D/g, ""))
      : excerpt.toLowerCase().includes(value.toLowerCase());
  });
}

function candidateHasOfficialProvenance(
  candidate: CandidateFile["candidates"][number]
): boolean {
  return (
    candidate.reasons.some((reason) => /official/i.test(reason)) ||
    candidate.discoveryPath.some((step) => /official/i.test(step.label))
  );
}

function originOf(value: string): string | undefined {
  try {
    return new URL(value).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return undefined;
  }
}

function latestTimestamp(values: Array<string | undefined>): string {
  return values
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? "1970-01-01T00:00:00.000Z";
}

function stageStatus(
  blocked: boolean,
  warning: boolean
): OpsStageStatus {
  if (blocked) return "blocked";
  if (warning) return "warning";
  return "healthy";
}

export function buildOpsDashboardSnapshot(input: {
  inventory: InventoryFile;
  candidates: CandidateFile;
  reviews: ReviewFile;
  registry: PublishedChannelRegistry;
  quality: PipelineQualitySnapshot;
  coverage: CoverageSnapshot;
  quarantine?: ReviewQuarantineSnapshot;
}): OpsDashboardSnapshot {
  const { inventory, candidates, reviews, registry, quality, coverage } = input;
  const candidatesById = new Map(
    candidates.candidates.map((candidate) => [candidate.id, candidate])
  );
  const currentDecisions = reviews.decisions.filter((decision) => {
    const candidate = candidatesById.get(decision.candidateId);
    return (
      candidate &&
      decision.reviewedCandidateVersion === candidateReviewVersion(candidate)
    );
  });
  const accepted = currentDecisions.filter(
    (decision) => decision.decision === "accept"
  ).length;
  const rejected = currentDecisions.filter(
    (decision) => decision.decision === "reject"
  ).length;
  const pending = Math.max(0, candidates.candidates.length - currentDecisions.length);
  const directContactFallbackVenueIds = new Set<string>();
  for (const candidate of candidates.candidates) {
    const isDirectContact =
      candidate.kind === "general_contact_form" ||
      ((candidate.kind === "email" || candidate.kind === "phone") &&
        Boolean(candidate.contactValue));
    if (
      isDirectContact &&
      candidateHasOfficialProvenance(candidate) &&
      !contactEvidenceIsBound(candidate)
    ) {
      for (const venueId of candidate.venueIds) {
        directContactFallbackVenueIds.add(venueId);
      }
    }
  }

  const candidateKindLabels: Record<string, string> = {
    email: "Email",
    phone: "Phone",
    general_contact_form: "Contact form",
    dedicated_lost_found_form: "Lost-property form",
    operator_lost_found_form: "Operator form",
    central_office_fallback: "Central fallback",
    manual_review: "Evidence only",
  };
  const kindCounts = new Map<string, number>();
  for (const candidate of candidates.candidates) {
    kindCounts.set(candidate.kind, (kindCounts.get(candidate.kind) ?? 0) + 1);
  }

  const byOrigin = new Map<
    string,
    {
      candidates: number;
      pages: Set<string>;
      contacts: number;
      needsReview: number;
      pendingCanonicalization: number;
      purposeBound: number;
    }
  >();
  for (const candidate of candidates.candidates) {
    const domain = originOf(candidate.pageUrl);
    if (!domain) continue;
    const current = byOrigin.get(domain) ?? {
      candidates: 0,
      pages: new Set<string>(),
      contacts: 0,
      needsReview: 0,
      pendingCanonicalization: 0,
      purposeBound: 0,
    };
    current.candidates += 1;
    current.pages.add(candidate.pageUrl);
    if (candidate.contactValue) current.contacts += 1;
    if (
      candidate.reviewStatus === "needs_review" ||
      candidate.kind === "manual_review"
    ) {
      current.needsReview += 1;
    }
    if (candidate.canonicalizationStatus === "pending") {
      current.pendingCanonicalization += 1;
    }
    if (contactEvidenceIsBound(candidate)) current.purposeBound += 1;
    byOrigin.set(domain, current);
  }
  const batchTargets = [...byOrigin.entries()]
    .map(([domain, value]) => {
      const directoryNoise =
        value.contacts >= 10 && value.purposeBound / value.contacts < 0.25;
      return {
        domain,
        candidates: value.candidates,
        pages: value.pages.size,
        contacts: value.contacts,
        needsReview: value.needsReview,
        pendingCanonicalization: value.pendingCanonicalization,
        reason: directoryNoise
          ? "High contact volume with weak local evidence"
          : value.pendingCanonicalization > 0
            ? "Place mapping is incomplete"
            : "Large unresolved candidate queue",
        risk:
          value.candidates +
          value.needsReview * 2 +
          value.pendingCanonicalization * 3 +
          (directoryNoise ? 50 : 0),
      };
    })
    .filter((target) => target.candidates >= 3)
    .sort((left, right) => right.risk - left.risk)
    .slice(0, 20)
    .map((target) => ({
      domain: target.domain,
      candidates: target.candidates,
      pages: target.pages,
      contacts: target.contacts,
      needsReview: target.needsReview,
      pendingCanonicalization: target.pendingCanonicalization,
      reason: target.reason,
    }));

  const issues: OpsIssue[] = [];
  if (quality.published.expiredChannels > 0) {
    issues.push({
      id: "expired-channels",
      severity: "critical",
      title: "Published channels are past review due",
      evidence: `${quality.published.expiredChannels} channel(s) are expired.`,
      action: "Re-verify or remove them before publishing another feed.",
    });
  }
  if (quality.review.orphanDecisions > 0) {
    issues.push({
      id: "orphan-reviews",
      severity: "high",
      title: "Review decisions no longer join candidates",
      evidence: `${quality.review.orphanDecisions} orphan decision(s).`,
      action: "Run review sanitation before the next AI batch.",
    });
  }
  const contactEvidenceRate =
    quality.discovery.contactCandidates > 0
      ? quality.discovery.purposeBoundContactCandidates /
        quality.discovery.contactCandidates
      : 1;
  if (contactEvidenceRate < 0.5) {
    issues.push({
      id: "candidate-evidence",
      severity: "low",
      title: "General contact fallbacks dominate the contact queue",
      evidence: `${quality.discovery.purposeBoundContactCandidates}/${quality.discovery.contactCandidates} contact candidates are explicitly bound to lost property; the remainder may still be useful official fallbacks.`,
      action: "Verify venue/operator ownership and publish same-site contacts with a fallback label.",
    });
  }
  const staleCheckpoints =
    quality.discovery.completedScopes -
    quality.discovery.currentCompletedScopes;
  if (staleCheckpoints > 0) {
    issues.push({
      id: "stale-checkpoints",
      severity: "medium",
      title: "Some crawl checkpoints are stale",
      evidence: `${staleCheckpoints} checkpoint(s) no longer match the current inventory.`,
      action: "Let the affected domains run again; valid checkpoints still resume.",
    });
  }
  if (quality.discovery.noisyPages.length > 0) {
    issues.push({
      id: "directory-noise",
      severity: "medium",
      title: "Contact-directory explosions remain in old data",
      evidence: `${quality.discovery.noisyPages.length} page(s) generated more than 10 candidates.`,
      action: "Prioritise the suggested noisy domains below.",
    });
  }
  if (quality.discovery.pendingCanonicalization > 0) {
    issues.push({
      id: "canonicalization",
      severity: "medium",
      title: "Google-discovered places still need open IDs",
      evidence: `${quality.discovery.pendingCanonicalization} candidate(s) cannot publish yet.`,
      action: "Resolve Google Place IDs to OSM or Wikidata before review.",
    });
  }
  const quarantinedDecisions = input.quarantine?.entries?.length ?? 0;
  if (quarantinedDecisions > 0) {
    issues.push({
      id: "quarantine",
      severity: "low",
      title: "Legacy decisions are retained for audit",
      evidence: `${quarantinedDecisions} stale decision(s) are isolated from publication.`,
      action: "Keep the file as audit history; no operational action is required.",
    });
  }

  const overallStatus = stageStatus(
    issues.some((issue) => issue.severity === "critical"),
    issues.some((issue) => issue.severity === "high" || issue.severity === "medium")
  );
  const crawlRate = quality.discovery.effectiveCompletionRate;
  const stages: OpsStage[] = [
    {
      id: "inventory",
      label: "Inventory",
      status: stageStatus(inventory.venues.length === 0, false),
      value: `${inventory.venues.length.toLocaleString("en-US")} venues`,
      detail: `${inventory.summary.officialWebsites.toLocaleString("en-US")} official website seeds`,
    },
    {
      id: "crawl",
      label: "Discovery",
      status: stageStatus(false, crawlRate < 1),
      value: `${Math.round(crawlRate * 100)}% current`,
      detail: `${quality.discovery.currentCompletedScopes}/${quality.discovery.currentScopeGroups} current scopes`,
    },
    {
      id: "review",
      label: "Review",
      status: stageStatus(
        quality.review.quarantinableAcceptances > 0,
        pending > 0
      ),
      value: `${accepted} accepted`,
      detail: `${pending.toLocaleString("en-US")} candidates pending`,
    },
    {
      id: "publish",
      label: "Published registry",
      status: stageStatus(
        registry.channels.length === 0 || quality.published.expiredChannels > 0,
        false
      ),
      value: `${registry.channels.length} channels`,
      detail: `${quality.published.coveredVenues} reviewed venues`,
    },
  ];

  return {
    generatedAt: latestTimestamp([
      quality.generatedAt,
      inventory.generatedAt,
      candidates.generatedAt,
      registry.generatedAt,
      coverage.generatedAt,
    ]),
    overallStatus,
    headline: {
      totalVenues: inventory.venues.length,
      crawlCompleted: quality.discovery.currentCompletedScopes,
      crawlTotal: quality.discovery.currentScopeGroups,
      crawlRate,
      candidates: candidates.candidates.length,
      currentAcceptances: accepted,
      publishedChannels: registry.channels.length,
      coveredVenues: quality.published.coveredVenues,
      // This tier means the venue/operator's official website is known. It is
      // deliberately separate from a directly extracted form, email or phone.
      officialSourceFallbackVenues: coverage.summary.officialContact,
      directContactFallbackCandidateVenues:
        directContactFallbackVenueIds.size,
    },
    stages,
    candidateMix: [...kindCounts.entries()]
      .map(([id, value]) => ({
        id,
        label: candidateKindLabels[id] ?? id,
        value,
      }))
      .sort((left, right) => right.value - left.value),
    reviewMix: [
      { id: "pending", label: "Pending", value: pending },
      { id: "accepted", label: "Accepted", value: accepted },
      { id: "rejected", label: "Rejected", value: rejected },
    ],
    coverage: {
      addressableVenues: coverage.summary.addressableVenues,
      addressableWithRoute: coverage.summary.addressableWithRoute,
      addressableRouteRate: coverage.summary.addressableRouteRate,
      tiers: coverage.tiers.map((tier) => ({
        id: tier.id,
        label: tier.label,
        value: tier.count,
      })),
    },
    sources: [
      {
        label: "Venue inventory",
        generatedAt: inventory.generatedAt,
        records: inventory.venues.length,
      },
      {
        label: "Candidate registry",
        generatedAt: candidates.generatedAt,
        records: candidates.candidates.length,
      },
      {
        label: "Current review file",
        generatedAt: latestTimestamp(
          currentDecisions.map((decision) => decision.reviewedAt)
        ),
        records: currentDecisions.length,
      },
      {
        label: "Published channels",
        generatedAt: registry.generatedAt,
        records: registry.channels.length,
      },
    ],
    issues,
    batchTargets,
    quarantinedDecisions,
  };
}
