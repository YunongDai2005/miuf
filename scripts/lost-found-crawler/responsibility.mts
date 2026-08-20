import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  isChannelReviewCurrent,
  type PublishedChannelRegistry,
  type PublishedLostFoundChannel,
} from "../../lib/lost-found-channel-schema";
import type {
  InventoryFile,
  ResponsibilityGraph,
  ResponsibilityRecord,
  VenueResponsibilityAssignment,
} from "./schemas";
import type { PublicLostFoundResponsibilityIndex } from "../../lib/lost-found-responsibility-schema";

const DEFAULT_GUIDANCE_URL =
  "https://www.berlin.de/ba-tempelhof-schoeneberg/politik-und-verwaltung/aemter/amt-fuer-buergerdienste/fundbuero/";

type MutableResponsibility = Omit<
  ResponsibilityRecord,
  "venueIds" | "channelIds" | "evidenceUrls"
> & {
  venueIds: Set<string>;
  channelIds: Set<string>;
  evidenceUrls: Set<string>;
};

function currentChannelsByVenue(
  registry: PublishedChannelRegistry,
  now: Date
): Map<string, PublishedLostFoundChannel[]> {
  const result = new Map<string, PublishedLostFoundChannel[]>();
  for (const channel of registry.channels) {
    if (!isChannelReviewCurrent(channel, now)) continue;
    for (const venueId of channel.venueIds) {
      const channels = result.get(venueId) ?? [];
      channels.push(channel);
      result.set(venueId, channels);
    }
  }
  return result;
}

function roundedRate(numerator: number, denominator: number): number {
  if (!denominator) return 1;
  return Number((numerator / denominator).toFixed(4));
}

export async function buildResponsibilityGraph(options: {
  inventoryPath: string;
  registryPath: string;
  outputPath: string;
  reportPath?: string;
  runtimePath?: string;
  guidanceUrl?: string;
  now?: Date;
}): Promise<ResponsibilityGraph> {
  const inventory = JSON.parse(
    await readFile(options.inventoryPath, "utf8")
  ) as InventoryFile;
  const registry = JSON.parse(
    await readFile(options.registryPath, "utf8")
  ) as PublishedChannelRegistry;
  if (
    inventory.version !== 1 ||
    registry.version !== 1 ||
    !Array.isArray(inventory.venues) ||
    !Array.isArray(registry.channels)
  ) {
    throw new Error("Unsupported inventory or channel registry");
  }

  const now = options.now ?? new Date();
  const channelsByVenue = currentChannelsByVenue(registry, now);
  const venuesById = new Map(
    inventory.venues.map((venue) => [venue.venueId, venue])
  );
  if (venuesById.size !== inventory.venues.length) {
    throw new Error("Inventory contains duplicate venue IDs");
  }
  const operatorsById = new Map(
    inventory.operators.map((operator) => [operator.id, operator])
  );
  const responsibilities = new Map<string, MutableResponsibility>();
  const assignments = new Map<string, VenueResponsibilityAssignment>();

  const ensureResponsibility = (
    value: Omit<ResponsibilityRecord, "venueIds" | "channelIds" | "evidenceUrls"> & {
      evidenceUrls?: string[];
    }
  ): MutableResponsibility => {
    const existing = responsibilities.get(value.id);
    if (existing) {
      for (const evidenceUrl of value.evidenceUrls ?? []) {
        existing.evidenceUrls.add(evidenceUrl);
      }
      existing.confidence = Math.max(existing.confidence, value.confidence);
      return existing;
    }
    const { evidenceUrls = [], ...base } = value;
    const created: MutableResponsibility = {
      ...base,
      venueIds: new Set<string>(),
      channelIds: new Set<string>(),
      evidenceUrls: new Set(evidenceUrls),
    };
    responsibilities.set(value.id, created);
    return created;
  };

  const guidance = ensureResponsibility({
    id: "guidance:berlin-venue-contact",
    kind: "guidance",
    name: "Berlin venue and public-space lost-property guidance",
    website: options.guidanceUrl ?? DEFAULT_GUIDANCE_URL,
    confidence: 1,
    audited: true,
    evidenceUrls: [options.guidanceUrl ?? DEFAULT_GUIDANCE_URL],
  });

  // First resolve every venue with a direct, evidence-bearing responsibility.
  for (const venue of inventory.venues) {
    const currentChannels = channelsByVenue.get(venue.venueId) ?? [];
    const currentChannelIds = currentChannels.map((channel) => channel.id).sort();
    const operator = venue.operatorId
      ? operatorsById.get(venue.operatorId)
      : undefined;
    const auditedOperator =
      operator?.resolutionSource === "official_source_audit" ? operator : undefined;
    let responsibility: MutableResponsibility | undefined;
    let resolution: VenueResponsibilityAssignment["resolution"] | undefined;
    let trust: VenueResponsibilityAssignment["trust"] | undefined;
    let confidence = venue.confidence;

    if (auditedOperator) {
      responsibility = ensureResponsibility({
        id: `operator:${auditedOperator.id}`,
        kind: "operator",
        name: auditedOperator.name,
        operatorId: auditedOperator.id,
        website: auditedOperator.website,
        confidence: auditedOperator.confidence,
        audited: true,
        auditedAt: auditedOperator.auditedAt,
        evidenceUrls: auditedOperator.evidenceUrls,
      });
      resolution = currentChannelIds.length
        ? "reviewed_channel"
        : "audited_operator";
      trust = currentChannelIds.length ? "reviewed" : "official";
      confidence = currentChannelIds.length ? 1 : auditedOperator.confidence;
    } else if (currentChannelIds.length) {
      responsibility = ensureResponsibility({
        id: `venue:${venue.canonicalVenueId}`,
        kind: "venue",
        name: venue.venueName,
        website: currentChannels[0].pageUrl,
        confidence: 1,
        audited: false,
        evidenceUrls: currentChannels.flatMap((channel) =>
          channel.evidence.map((evidence) => evidence.sourceUrl)
        ),
      });
      resolution = "reviewed_channel";
      trust = "reviewed";
      confidence = 1;
    } else if (venue.officialWebsite || venue.operatorWebsite) {
      responsibility = ensureResponsibility({
        id: `venue:${venue.canonicalVenueId}`,
        kind: "venue",
        name: venue.venueName,
        website: venue.officialWebsite ?? venue.operatorWebsite,
        confidence: venue.confidence,
        audited: false,
        evidenceUrls: venue.evidenceUrls,
      });
      resolution = "official_venue";
      trust = "official";
    }

    if (!responsibility || !resolution || !trust) continue;
    responsibility.venueIds.add(venue.venueId);
    for (const channelId of currentChannelIds) {
      responsibility.channelIds.add(channelId);
    }
    assignments.set(venue.venueId, {
      venueId: venue.venueId,
      responsibilityId: responsibility.id,
      resolution,
      trust,
      channelIds: currentChannelIds,
      confidence,
      evidenceUrls: [...responsibility.evidenceUrls].sort(),
    });
  }

  // Parent proximity is useful for prioritising review, but never silently
  // inherits a channel. Only direct/audited assignments are publishable.
  for (const venue of inventory.venues) {
    if (assignments.has(venue.venueId)) continue;
    const parentVenueId = venue.parentVenueCandidateId;
    const parentAssignment = parentVenueId
      ? assignments.get(parentVenueId)
      : undefined;
    const parentResponsibility = parentAssignment
      ? responsibilities.get(parentAssignment.responsibilityId)
      : undefined;
    if (parentVenueId && parentAssignment && parentResponsibility) {
      parentResponsibility.venueIds.add(venue.venueId);
      assignments.set(venue.venueId, {
        venueId: venue.venueId,
        responsibilityId: parentResponsibility.id,
        resolution: "parent_candidate",
        trust: "candidate",
        channelIds: [],
        parentVenueId,
        confidence: Math.max(
          0.2,
          Number(
            (
              0.7 - (venue.parentCandidateDistanceMeters ?? 250) / 1_000
            ).toFixed(3)
          )
        ),
        evidenceUrls: [],
      });
      continue;
    }
    guidance.venueIds.add(venue.venueId);
    assignments.set(venue.venueId, {
      venueId: venue.venueId,
      responsibilityId: guidance.id,
      resolution: "manual_guidance",
      trust: "fallback",
      channelIds: [],
      confidence: 1,
      evidenceUrls: [...guidance.evidenceUrls],
    });
  }

  const sortedAssignments = [...assignments.values()].sort((left, right) =>
    left.venueId.localeCompare(right.venueId)
  );
  if (sortedAssignments.length !== inventory.venues.length) {
    throw new Error("Responsibility graph did not resolve every venue");
  }
  const count = (resolution: VenueResponsibilityAssignment["resolution"]): number =>
    sortedAssignments.filter((assignment) => assignment.resolution === resolution)
      .length;
  const reviewedChannel = count("reviewed_channel");
  const officialContact = count("audited_operator") + count("official_venue");
  const parentCandidate = count("parent_candidate");
  const manualGuidance = count("manual_guidance");
  const totalVenues = sortedAssignments.length;

  // A venue can only have its own lost-property route if some organisation
  // stands behind it. The inventory already records that: an independent
  // candidate with an official website or a known operator is addressable, a
  // place that resolves to a parent inherits that parent's route, and the rest
  // — the sculptures and memorial plaques the place index carries so that a
  // photograph can be given a name — have no office to route to at all, and
  // correctly fall to the district or central office.
  const addressable = new Set<string>();
  const inheriting = new Set<string>();
  for (const venue of inventory.venues) {
    if (venue.resolutionStatus === "independent_candidate" ||
        venue.officialWebsite ||
        venue.operatorId) {
      addressable.add(venue.venueId);
    } else if (venue.resolutionStatus === "parent_venue_required") {
      inheriting.add(venue.venueId);
    }
  }
  // "official_venue" means the venue's own website is known, not that a
  // lost-property route was found on it, so it is counted as a weaker tier of
  // its own. Folding the two together would report a coverage of almost 100 per
  // cent while most of those venues still leave the traveller to search a
  // homepage unaided.
  const addressableWithRoute = sortedAssignments.filter(
    (assignment) =>
      addressable.has(assignment.venueId) &&
      (assignment.resolution === "reviewed_channel" ||
        assignment.resolution === "audited_operator")
  ).length;
  const addressableWithSourceOnly = sortedAssignments.filter(
    (assignment) =>
      addressable.has(assignment.venueId) &&
      assignment.resolution === "official_venue"
  ).length;
  const generatedAt = now.toISOString();
  const graph: ResponsibilityGraph = {
    version: 1,
    generatedAt,
    inventoryGeneratedAt: inventory.generatedAt,
    channelRegistryGeneratedAt: registry.generatedAt,
    responsibilities: [...responsibilities.values()]
      .filter((responsibility) => responsibility.venueIds.size > 0)
      .map((responsibility) => ({
        ...responsibility,
        venueIds: [...responsibility.venueIds].sort(),
        channelIds: [...responsibility.channelIds].sort(),
        evidenceUrls: [...responsibility.evidenceUrls].sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    assignments: sortedAssignments,
    summary: {
      totalVenues,
      resolvedVenues: sortedAssignments.length,
      reviewedChannel,
      officialContact,
      parentCandidate,
      manualGuidance,
      actionableCoverageRate: roundedRate(
        reviewedChannel + officialContact,
        totalVenues
      ),
      functionalCoverageRate: roundedRate(sortedAssignments.length, totalVenues),
      addressableVenues: addressable.size,
      addressableWithRoute,
      addressableWithSourceOnly,
      addressableRouteRate: roundedRate(addressableWithRoute, addressable.size),
      inheritsFromParent: inheriting.size,
      noVenueOfficePossible:
        totalVenues - addressable.size - inheriting.size,
    },
  };
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(graph, null, 2)}\n`);

  if (options.reportPath) {
    const report = {
      version: 1,
      generatedAt,
      summary: graph.summary,
      tiers: [
        {
          id: "reviewed_channel",
          label: "Reviewed venue/operator channel",
          count: reviewedChannel,
        },
        {
          id: "official_contact",
          label: "Official venue/operator website fallback",
          count: officialContact,
        },
        {
          id: "parent_candidate",
          label: "Parent venue candidate awaiting ownership review",
          count: parentCandidate,
        },
        {
          id: "manual_guidance",
          label: "Venue/public-space guidance fallback",
          count: manualGuidance,
        },
      ],
    };
    await mkdir(dirname(options.reportPath), { recursive: true });
    await writeFile(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (options.runtimePath) {
    const runtimeIndex: PublicLostFoundResponsibilityIndex = {
      version: 1,
      generatedAt,
      responsibilities: graph.responsibilities.map((responsibility) => ({
        id: responsibility.id,
        kind: responsibility.kind,
        name: responsibility.name,
        website: responsibility.website,
        audited: responsibility.audited,
        auditedAt: responsibility.auditedAt,
        evidenceUrls: responsibility.evidenceUrls,
      })),
      assignments: graph.assignments.map((assignment) => ({
        venueId: assignment.venueId,
        responsibilityId: assignment.responsibilityId,
        resolution: assignment.resolution,
        trust: assignment.trust,
        channelIds: assignment.channelIds,
        parentVenueId: assignment.parentVenueId,
        confidence: assignment.confidence,
      })),
    };
    await mkdir(dirname(options.runtimePath), { recursive: true });
    await writeFile(
      options.runtimePath,
      `${JSON.stringify(runtimeIndex, null, 2)}\n`
    );
  }
  return graph;
}
