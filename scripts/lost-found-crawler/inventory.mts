import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { stableId } from "./hash.mjs";
import type {
  InventoryFile,
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

export async function buildInventory(options: {
  inputPath: string;
  outputPath: string;
  sourceLabel?: string;
}): Promise<InventoryFile> {
  const payload = JSON.parse(await readFile(options.inputPath, "utf8")) as AttractionFile;
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
    const operatorWebsite = validWebUrl(
      attraction.operatorWebsite ?? canonical.operatorWebsite
    );
    const operatorName =
      attraction.operator?.trim() || canonical.operator?.trim() || undefined;
    const operatorKey = operatorName ? normalizedName(operatorName) : "";
    const operatorId = operatorKey ? stableId("operator", operatorKey) : undefined;
    const evidenceUrls = [
      attraction.contactSourceUrl,
      attraction.websiteSourceUrl,
    ].filter((value): value is string => Boolean(value));

    if (operatorId && operatorName) {
      const existing = operatorsByKey.get(operatorKey);
      if (existing) {
        if (!existing.venueIds.includes(attraction.id)) existing.venueIds.push(attraction.id);
        for (const evidence of evidenceUrls) {
          if (!existing.evidenceUrls.includes(evidence)) existing.evidenceUrls.push(evidence);
        }
        existing.website ??= operatorWebsite;
      } else {
        operatorsByKey.set(operatorKey, {
          id: operatorId,
          name: operatorName,
          website: operatorWebsite,
          venueIds: [attraction.id],
          confidence: operatorWebsite ? 0.85 : 0.72,
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
      resolutionStatus,
      confidence: operatorName
        ? operatorWebsite
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
