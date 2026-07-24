import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stableId } from "./hash.mjs";
import type {
  InventoryFile,
  OperatorOverride,
  OperatorOverrideFile,
  OperatorRecord,
  VenueOwnerResolution,
} from "./schemas";

type Attraction = {
  id: string;
  name: string;
  category: string;
  point: [number, number];
  wikidata?: string;
  website?: string;
  operator?: string;
  operatorWebsite?: string;
  contactSourceUrl?: string;
  websiteSourceUrl?: string;
};

type AttractionFile = {
  attractions: Attraction[];
};

const PARENT_FIRST_CATEGORIES = new Set([
  "artwork",
  "memorial",
  "viewpoint",
  "ruins",
]);

class DisjointSet {
  private readonly parent = new Map<string, string>();

  add(id: string): void {
    if (!this.parent.has(id)) this.parent.set(id, id);
  }

  find(id: string): string {
    const parent = this.parent.get(id);
    if (!parent || parent === id) return id;
    const root = this.find(parent);
    this.parent.set(id, root);
    return root;
  }

  union(left: string, right: string): void {
    const leftRoot = this.find(left);
    const rightRoot = this.find(right);
    if (leftRoot !== rightRoot) this.parent.set(rightRoot, leftRoot);
  }
}

function distanceMeters(
  left: [number, number],
  right: [number, number]
): number {
  const radius = 6_371_000;
  const radians = Math.PI / 180;
  const lat1 = left[0] * radians;
  const lat2 = right[0] * radians;
  const deltaLat = (right[0] - left[0]) * radians;
  const deltaLon = (right[1] - left[1]) * radians;
  const value =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function normalizedName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function validWebUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return undefined;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizedHostname(value: string): string {
  return new URL(value).hostname.replace(/^www\./i, "").toLowerCase();
}

function validateOperatorOverrides(
  value: unknown
): OperatorOverride[] {
  if (!value || typeof value !== "object") {
    throw new Error("Operator override file must be an object");
  }
  const file = value as Partial<OperatorOverrideFile>;
  if (file.version !== 1 || !Array.isArray(file.operators)) {
    throw new Error("Unsupported operator override file");
  }
  const claimedHosts = new Set<string>();
  const claimedVenues = new Set<string>();
  return file.operators.map((entry, index) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      typeof entry.name !== "string" ||
      !entry.name.trim() ||
      typeof entry.website !== "string" ||
      !validWebUrl(entry.website) ||
      !Array.isArray(entry.evidenceUrls) ||
      entry.evidenceUrls.length === 0 ||
      entry.evidenceUrls.some((url) => !validWebUrl(url)) ||
      (entry.discoverySeedUrls !== undefined &&
        (!Array.isArray(entry.discoverySeedUrls) ||
          entry.discoverySeedUrls.some((url) => !validWebUrl(url)))) ||
      typeof entry.auditedAt !== "string" ||
      !Number.isFinite(Date.parse(entry.auditedAt))
    ) {
      throw new Error(`Invalid operator override at index ${index}`);
    }
    const website = validWebUrl(entry.website)!;
    const discoverySeedUrls = (entry.discoverySeedUrls ?? []).map(
      (url) => validWebUrl(url)!
    );
    if (
      discoverySeedUrls.some(
        (url) => normalizedHostname(url) !== normalizedHostname(website)
      )
    ) {
      throw new Error(
        `Operator discovery seed must share the audited website host at index ${index}`
      );
    }
    const matchWebsiteHosts = (entry.matchWebsiteHosts ?? []).map((host) =>
      host.replace(/^www\./i, "").trim().toLowerCase()
    );
    if (
      matchWebsiteHosts.some(
        (host) =>
          !host ||
          host.includes("/") ||
          host.includes(":") ||
          claimedHosts.has(host)
      )
    ) {
      throw new Error(`Invalid or duplicate operator host at index ${index}`);
    }
    const venueIds = (entry.venueIds ?? []).map((id) => id.trim());
    if (
      venueIds.some((id) => !id || claimedVenues.has(id)) ||
      (matchWebsiteHosts.length === 0 && venueIds.length === 0)
    ) {
      throw new Error(`Invalid or duplicate operator venue at index ${index}`);
    }
    matchWebsiteHosts.forEach((host) => claimedHosts.add(host));
    venueIds.forEach((id) => claimedVenues.add(id));
    return {
      name: entry.name.trim(),
      website,
      discoverySeedUrls,
      matchWebsiteHosts,
      venueIds,
      evidenceUrls: entry.evidenceUrls.map((url) => validWebUrl(url)!),
      auditedAt: new Date(entry.auditedAt).toISOString(),
    };
  });
}

export async function buildInventory(options: {
  inputPath: string;
  outputPath: string;
  sourceLabel?: string;
  operatorOverridePath?: string;
}): Promise<InventoryFile> {
  const payload = JSON.parse(await readFile(options.inputPath, "utf8")) as AttractionFile;
  const operatorOverrides = options.operatorOverridePath
    ? validateOperatorOverrides(
        JSON.parse(await readFile(options.operatorOverridePath, "utf8"))
      )
    : [];
  const overridesByHost = new Map<string, OperatorOverride>();
  const overridesByVenue = new Map<string, OperatorOverride>();
  for (const override of operatorOverrides) {
    for (const host of override.matchWebsiteHosts ?? []) {
      overridesByHost.set(host, override);
    }
    for (const venueId of override.venueIds ?? []) {
      overridesByVenue.set(venueId, override);
    }
  }
  const operatorsByKey = new Map<string, OperatorRecord>();
  const disjointSet = new DisjointSet();
  for (const attraction of payload.attractions) disjointSet.add(attraction.id);
  const byWikidata = new Map<string, Attraction[]>();
  const byName = new Map<string, Attraction[]>();
  for (const attraction of payload.attractions) {
    if (attraction.wikidata) {
      const entries = byWikidata.get(attraction.wikidata) ?? [];
      entries.push(attraction);
      byWikidata.set(attraction.wikidata, entries);
    }
    const nameKey = normalizedName(attraction.name);
    const namedEntries = byName.get(nameKey) ?? [];
    namedEntries.push(attraction);
    byName.set(nameKey, namedEntries);
  }
  for (const entries of byWikidata.values()) {
    for (const entry of entries.slice(1)) disjointSet.union(entries[0].id, entry.id);
  }
  for (const entries of byName.values()) {
    if (entries.length < 2) continue;
    for (let left = 0; left < entries.length; left += 1) {
      for (let right = left + 1; right < entries.length; right += 1) {
        if (distanceMeters(entries[left].point, entries[right].point) <= 50) {
          disjointSet.union(entries[left].id, entries[right].id);
        }
      }
    }
  }
  const groupedAttractions = new Map<string, Attraction[]>();
  for (const attraction of payload.attractions) {
    const rootId = disjointSet.find(attraction.id);
    const entries = groupedAttractions.get(rootId) ?? [];
    entries.push(attraction);
    groupedAttractions.set(rootId, entries);
  }
  const categoryRank = new Map([
    ["museum", 0],
    ["castle", 1],
    ["leisure", 2],
    ["landmark", 3],
    ["memorial", 4],
    ["viewpoint", 5],
    ["ruins", 6],
    ["artwork", 7],
  ]);
  const groupByVenueId = new Map<
    string,
    { id: string; canonical: Attraction; venueIds: string[]; reason: "wikidata" | "near_duplicate" | "single" }
  >();
  const entityGroups: InventoryFile["entityGroups"] = [];
  for (const entries of groupedAttractions.values()) {
    const sorted = [...entries].sort((left, right) => {
      const leftSource = left.website || left.operatorWebsite || left.operator ? 0 : 1;
      const rightSource = right.website || right.operatorWebsite || right.operator ? 0 : 1;
      return (
        leftSource - rightSource ||
        (categoryRank.get(left.category) ?? 99) - (categoryRank.get(right.category) ?? 99) ||
        left.name.length - right.name.length
      );
    });
    const canonical = sorted[0];
    const venueIds = sorted.map((entry) => entry.id).sort();
    const groupId = stableId("venue_group", venueIds);
    const sharedWikidata =
      entries.length > 1 &&
      Boolean(entries[0].wikidata) &&
      entries.every((entry) => entry.wikidata === entries[0].wikidata);
    const reason: "wikidata" | "near_duplicate" | "single" = entries.length === 1
      ? "single"
      : sharedWikidata
        ? "wikidata"
        : "near_duplicate";
    const group = { id: groupId, canonical, venueIds, reason };
    entityGroups.push({
      id: groupId,
      canonicalVenueId: canonical.id,
      venueIds,
      reason,
    });
    for (const entry of entries) groupByVenueId.set(entry.id, group);
  }
  const venues: VenueOwnerResolution[] = [];

  for (const attraction of payload.attractions) {
    const entityGroup = groupByVenueId.get(attraction.id);
    if (!entityGroup) throw new Error(`Missing entity group for ${attraction.id}`);
    const canonical = entityGroup.canonical;
    const officialWebsite = validWebUrl(attraction.website ?? canonical.website);
    const auditedOverride =
      overridesByVenue.get(attraction.id) ??
      (officialWebsite
        ? overridesByHost.get(normalizedHostname(officialWebsite))
        : undefined);
    const operatorWebsite = auditedOverride?.website ?? validWebUrl(
      attraction.operatorWebsite ?? canonical.operatorWebsite
    );
    const operatorName =
      auditedOverride?.name ??
      attraction.operator?.trim() ??
      canonical.operator?.trim() ??
      undefined;
    const operatorResolutionSource = operatorName
      ? auditedOverride
        ? "official_source_audit"
        : "metadata_candidate"
      : undefined;
    const operatorKey = operatorName ? normalizedName(operatorName) : "";
    const operatorId = operatorKey ? stableId("operator", operatorKey) : undefined;
    const evidenceUrls = [
      ...(auditedOverride?.evidenceUrls ?? []),
      attraction.contactSourceUrl,
      attraction.websiteSourceUrl,
    ].filter(
      (value, index, all): value is string =>
        Boolean(value) && all.indexOf(value) === index
    );

    if (operatorId && operatorName) {
      const existing = operatorsByKey.get(operatorKey);
      if (existing) {
        if (!existing.venueIds.includes(attraction.id)) existing.venueIds.push(attraction.id);
        for (const evidence of evidenceUrls) {
          if (!existing.evidenceUrls.includes(evidence)) existing.evidenceUrls.push(evidence);
        }
        for (const seedUrl of auditedOverride?.discoverySeedUrls ?? []) {
          existing.discoverySeedUrls ??= [];
          if (!existing.discoverySeedUrls.includes(seedUrl)) {
            existing.discoverySeedUrls.push(seedUrl);
          }
        }
        existing.website ??= operatorWebsite;
        if (operatorResolutionSource === "official_source_audit") {
          existing.resolutionSource = operatorResolutionSource;
          existing.confidence = 0.98;
        }
      } else {
        operatorsByKey.set(operatorKey, {
          id: operatorId,
          name: operatorName,
          website: operatorWebsite,
          discoverySeedUrls: auditedOverride?.discoverySeedUrls,
          venueIds: [attraction.id],
          confidence:
            operatorResolutionSource === "official_source_audit"
              ? 0.98
              : operatorWebsite
                ? 0.85
                : 0.72,
          resolutionSource:
            operatorResolutionSource ?? "metadata_candidate",
          evidenceUrls: [...evidenceUrls],
        });
      }
    }

    const parentRequired =
      PARENT_FIRST_CATEGORIES.has(attraction.category) &&
      !officialWebsite &&
      !operatorName;
    const hasSource = Boolean(
      officialWebsite || operatorWebsite || operatorName
    );
    const resolutionStatus = parentRequired
      ? "parent_venue_required"
      : hasSource
        ? "independent_candidate"
        : "insufficient_source";

    venues.push({
      venueId: attraction.id,
      venueName: attraction.name,
      category: attraction.category,
      point: attraction.point,
      entityGroupId: entityGroup.id,
      canonicalVenueId: canonical.id,
      officialWebsite,
      operatorId,
      operatorName,
      operatorWebsite,
      operatorResolutionSource,
      resolutionStatus,
      confidence: operatorName
        ? operatorResolutionSource === "official_source_audit"
          ? 0.98
          : operatorWebsite
            ? 0.85
            : 0.72
        : officialWebsite
          ? 0.62
          : 0.1,
      evidenceUrls,
    });
  }

  const independentVenues = venues.filter(
    (venue) => venue.resolutionStatus === "independent_candidate"
  );
  for (const venue of venues) {
    if (venue.resolutionStatus !== "parent_venue_required") continue;
    let nearest:
      | { venue: VenueOwnerResolution; distance: number }
      | undefined;
    for (const candidate of independentVenues) {
      if (candidate.entityGroupId === venue.entityGroupId) continue;
      const distance = distanceMeters(venue.point, candidate.point);
      if (distance > 250 || (nearest && distance >= nearest.distance)) continue;
      nearest = { venue: candidate, distance };
    }
    if (nearest) {
      venue.parentVenueCandidateId = nearest.venue.canonicalVenueId;
      venue.parentCandidateDistanceMeters = Math.round(nearest.distance);
    }
  }

  const operators = [...operatorsByKey.values()]
    .map((operator) => ({
      ...operator,
      discoverySeedUrls: operator.discoverySeedUrls
        ? [...operator.discoverySeedUrls].sort()
        : undefined,
      venueIds: [...operator.venueIds].sort(),
      evidenceUrls: [...operator.evidenceUrls].sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "de"));
  venues.sort((left, right) => left.venueName.localeCompare(right.venueName, "de"));
  entityGroups.sort((left, right) => left.id.localeCompare(right.id));

  const inventory: InventoryFile = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sourceFile: options.sourceLabel ?? options.inputPath,
    operators,
    entityGroups,
    venues,
    summary: {
      totalVenues: venues.length,
      independentCandidates: venues.filter(
        (venue) => venue.resolutionStatus === "independent_candidate"
      ).length,
      parentVenueRequired: venues.filter(
        (venue) => venue.resolutionStatus === "parent_venue_required"
      ).length,
      insufficientSource: venues.filter(
        (venue) => venue.resolutionStatus === "insufficient_source"
      ).length,
      explicitOperators: operators.length,
      officialWebsites: venues.filter((venue) => venue.officialWebsite).length,
      duplicateGroups: entityGroups.filter((group) => group.venueIds.length > 1).length,
      parentCandidates: venues.filter((venue) => venue.parentVenueCandidateId).length,
    },
  };

  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(inventory, null, 2)}\n`);
  return inventory;
}
