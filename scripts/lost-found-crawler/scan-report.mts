import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  isChannelReviewCurrent,
  type PublishedChannelRegistry,
  type PublishedLostFoundChannel,
} from "../../lib/lost-found-channel-schema";
import { candidateReviewVersion } from "../../lib/channel-review";
import type {
  CandidateFile,
  ChannelCandidate,
  InventoryFile,
  ReviewDecision,
  ReviewFile,
  VenueEndpointScanFile,
  VenueEndpointScanRecord,
  VenueEndpointScanStatus,
  VenueEndpointSummary,
} from "./schemas";

const LOST_EVIDENCE_PATTERN =
  /explicit(?:ly)? mentions? lost|lost[- ]property (?:policy|purpose|service)|official lost[- ]property|page explicitly mentions lost/i;

const KIND_RANK: Record<VenueEndpointSummary["kind"], number> = {
  dedicated_lost_found_form: 0,
  operator_lost_found_form: 1,
  email: 2,
  phone: 3,
  general_contact_form: 4,
  central_office_fallback: 5,
  manual_review: 6,
};

export function candidateHasLostPropertyEvidence(
  candidate: ChannelCandidate
): boolean {
  return (
    candidate.kind === "dedicated_lost_found_form" ||
    candidate.kind === "operator_lost_found_form" ||
    LOST_EVIDENCE_PATTERN.test(candidate.reasons.join(" "))
  );
}

function candidateEndpoint(candidate: ChannelCandidate): VenueEndpointSummary {
  return {
    source: "candidate",
    id: candidate.id,
    kind: candidate.kind,
    pageUrl: candidate.pageUrl,
    formAction: candidate.form?.formAction,
    formMethod: candidate.form?.formMethod,
    contactValue: candidate.contactValue,
    hasForm: Boolean(candidate.form),
    fieldCount: candidate.form?.fields.filter((field) => field.control !== "hidden")
      .length ?? 0,
    captcha: candidate.form?.captcha ?? false,
    loginRequired: candidate.form?.loginRequired ?? false,
    lostPropertyEvidence: candidateHasLostPropertyEvidence(candidate),
    confidence: candidate.confidence,
  };
}

function reviewedEndpoint(
  channel: PublishedLostFoundChannel
): VenueEndpointSummary {
  return {
    source: "reviewed",
    id: channel.id,
    kind: channel.kind,
    pageUrl: channel.pageUrl,
    formAction: channel.formAction,
    formMethod: channel.formMethod,
    contactValue: channel.contactValue,
    hasForm: channel.fields.length > 0,
    fieldCount: channel.fields.filter((field) => field.control !== "hidden")
      .length,
    captcha: channel.captcha,
    loginRequired: channel.loginRequired,
    lostPropertyEvidence: true,
    verifiedAt: channel.verifiedAt,
  };
}

function endpointRank(endpoint: VenueEndpointSummary): number[] {
  return [
    endpoint.source === "reviewed" ? 0 : 1,
    endpoint.lostPropertyEvidence ? 0 : 1,
    KIND_RANK[endpoint.kind],
    -(endpoint.confidence ?? 100),
  ];
}

function compareEndpoints(
  left: VenueEndpointSummary,
  right: VenueEndpointSummary
): number {
  const leftRank = endpointRank(left);
  const rightRank = endpointRank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (leftRank[index] !== rightRank[index]) {
      return leftRank[index] - rightRank[index];
    }
  }
  return left.pageUrl.localeCompare(right.pageUrl);
}

function dedupeEndpoints(
  endpoints: VenueEndpointSummary[]
): VenueEndpointSummary[] {
  const byId = new Map<string, VenueEndpointSummary>();
  for (const endpoint of [...endpoints].sort(compareEndpoints)) {
    if (!byId.has(endpoint.id)) byId.set(endpoint.id, endpoint);
  }
  return [...byId.values()];
}

function statusFor(input: {
  endpoints: VenueEndpointSummary[];
  scanned: boolean;
  hasOfficialSource: boolean;
  parentVenueCandidateId?: string;
}): VenueEndpointScanStatus {
  if (input.endpoints.some((endpoint) => endpoint.source === "reviewed")) {
    return "reviewed_endpoint";
  }
  if (input.endpoints.some((endpoint) => endpoint.lostPropertyEvidence)) {
    return "lost_found_candidate";
  }
  if (input.endpoints.length > 0) return "official_contact_candidate";
  if (input.scanned) return "scanned_no_endpoint";
  if (input.hasOfficialSource) return "pending_scan";
  if (input.parentVenueCandidateId) return "parent_venue_candidate";
  return "no_official_source";
}

export async function buildVenueEndpointScanReport(options: {
  inventoryPath: string;
  candidatePaths: string[];
  registryPath: string;
  reviewPath?: string;
  outputPath: string;
  now?: Date;
}): Promise<VenueEndpointScanFile> {
  if (!options.candidatePaths.length) {
    throw new Error("At least one candidate file is required");
  }
  const inventory = JSON.parse(
    await readFile(options.inventoryPath, "utf8")
  ) as InventoryFile;
  const candidateFiles = await Promise.all(
    options.candidatePaths.map(async (path) =>
      JSON.parse(await readFile(path, "utf8")) as CandidateFile
    )
  );
  const registry = JSON.parse(
    await readFile(options.registryPath, "utf8")
  ) as PublishedChannelRegistry;
  const reviews = options.reviewPath
    ? (JSON.parse(await readFile(options.reviewPath, "utf8")) as ReviewFile)
    : undefined;
  if (
    inventory.version !== 1 ||
    registry.version !== 1 ||
    candidateFiles.some((file) => file.version !== 1) ||
    (reviews !== undefined && reviews.version !== 1)
  ) {
    throw new Error("Unsupported inventory, candidate or registry version");
  }

  const now = options.now ?? new Date();
  const scannedVenueIds = new Set(
    candidateFiles.flatMap((file) =>
      (file.completedScopes ?? []).flatMap((scope) => scope.venueIds)
    )
  );
  const candidateEndpointsByVenue = new Map<string, VenueEndpointSummary[]>();
  const candidatesById = new Map<string, ChannelCandidate>();
  for (const file of candidateFiles) {
    for (const candidate of file.candidates) {
      const existing = candidatesById.get(candidate.id);
      if (!existing || candidate.confidence > existing.confidence) {
        candidatesById.set(candidate.id, candidate);
      }
    }
  }
  const latestDecisions = new Map<string, ReviewDecision>();
  for (const decision of reviews?.decisions ?? []) {
    const existing = latestDecisions.get(decision.candidateId);
    if (!existing || decision.reviewedAt > existing.reviewedAt) {
      latestDecisions.set(decision.candidateId, decision);
    }
  }
  const rejectedCandidateIds = new Set(
    [...latestDecisions.values()]
      .filter((decision) => {
        const candidate = candidatesById.get(decision.candidateId);
        return (
          decision.decision === "reject" &&
          candidate !== undefined &&
          decision.reviewedCandidateVersion === candidateReviewVersion(candidate)
        );
      })
      .map((decision) => decision.candidateId)
  );
  const candidateVenueIds = new Set(
    [...candidatesById.values()].flatMap((candidate) => candidate.venueIds)
  );
  for (const candidate of candidatesById.values()) {
    if (
      candidate.reviewStatus === "rejected" ||
      rejectedCandidateIds.has(candidate.id)
    ) {
      continue;
    }
    const endpoint = candidateEndpoint(candidate);
    for (const venueId of candidate.venueIds) {
      const endpoints = candidateEndpointsByVenue.get(venueId) ?? [];
      endpoints.push(endpoint);
      candidateEndpointsByVenue.set(venueId, endpoints);
    }
  }

  const reviewedEndpointsByVenue = new Map<string, VenueEndpointSummary[]>();
  for (const channel of registry.channels) {
    if (!isChannelReviewCurrent(channel, now)) continue;
    const endpoint = reviewedEndpoint(channel);
    for (const venueId of channel.venueIds) {
      const endpoints = reviewedEndpointsByVenue.get(venueId) ?? [];
      endpoints.push(endpoint);
      reviewedEndpointsByVenue.set(venueId, endpoints);
    }
  }

  const records: VenueEndpointScanRecord[] = inventory.venues
    .map((venue) => {
      const endpoints = dedupeEndpoints([
        ...(reviewedEndpointsByVenue.get(venue.venueId) ?? []),
        ...(candidateEndpointsByVenue.get(venue.venueId) ?? []),
      ]);
      const scanned =
        scannedVenueIds.has(venue.venueId) ||
        candidateVenueIds.has(venue.venueId);
      const hasOfficialSource = Boolean(
        venue.officialWebsite || venue.operatorWebsite
      );
      return {
        venueId: venue.venueId,
        venueName: venue.venueName,
        category: venue.category,
        status: statusFor({
          endpoints,
          scanned,
          hasOfficialSource,
          parentVenueCandidateId: venue.parentVenueCandidateId,
        }),
        officialWebsite: venue.officialWebsite,
        operatorId: venue.operatorId,
        operatorName: venue.operatorName,
        operatorWebsite: venue.operatorWebsite,
        parentVenueCandidateId: venue.parentVenueCandidateId,
        scanned,
        bestEndpoint: endpoints[0],
        endpoints,
      } satisfies VenueEndpointScanRecord;
    })
    .sort((left, right) => left.venueId.localeCompare(right.venueId));

  const statuses: VenueEndpointScanStatus[] = [
    "reviewed_endpoint",
    "lost_found_candidate",
    "official_contact_candidate",
    "scanned_no_endpoint",
    "pending_scan",
    "parent_venue_candidate",
    "no_official_source",
  ];
  const statusCounts = Object.fromEntries(
    statuses.map((status) => [
      status,
      records.filter((record) => record.status === status).length,
    ])
  ) as Record<VenueEndpointScanStatus, number>;
  const output: VenueEndpointScanFile = {
    version: 1,
    generatedAt: now.toISOString(),
    inventoryGeneratedAt: inventory.generatedAt,
    candidateGeneratedAt: candidateFiles.map((file) => file.generatedAt),
    registryGeneratedAt: registry.generatedAt,
    records,
    summary: {
      totalVenues: records.length,
      scannableVenues: records.filter(
        (record) => record.officialWebsite || record.operatorWebsite
      ).length,
      scannedVenues: records.filter((record) => record.scanned).length,
      endpointVenues: records.filter((record) => record.endpoints.length > 0)
        .length,
      rejectedCandidates: rejectedCandidateIds.size,
      statusCounts,
    },
  };
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(output, null, 2)}\n`);
  return output;
}
