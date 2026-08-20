import type { LL } from "../berlin-transit/geo";
import type {
  TransitLine,
  TransitMode,
  TransitNetwork,
  TransitOperator,
} from "../berlin-transit/transit";
import {
  CATEGORY_META,
  type Attraction,
  type AttractionCategory,
  type AttractionSet,
} from "../berlin-transit/attractions";
import type { ItineraryJourney } from "./types";
import { apiGetJson } from "./net";
import {
  isChannelReviewCurrent,
  isPublishedChannelRegistry,
  publishedChannelPurpose,
  type PublishedChannelRegistry,
  type PublishedLostFoundChannel,
} from "../../lib/lost-found-channel-schema";
import {
  isPublicLostFoundResponsibilityIndex,
  type PublicLostFoundResponsibilityIndex,
  type ResolvedLostFoundResponsibility,
} from "../../lib/lost-found-responsibility-schema";
import {
  fetchRemoteLostFoundData,
  readCachedLostFoundData,
} from "./remoteData";

/** One thing the traveller can add to their retrace: a transit line or a venue. */
export interface SearchItem {
  kind: "line" | "venue";
  refId: string;
  label: string;
  sublabel: string;
  mode?: TransitMode;
  category?: AttractionCategory;
  color?: string;
  point?: LL; // [lat, lng] — set for venues, used for photo-based matching
  journeys?: ItineraryJourney[];
  operators?: TransitOperator[];
  officialWebsite?: string;
  officialPhone?: string;
  officialEmail?: string;
  lostFoundUrl?: string;
  contactSourceUrl?: string;
  officialWebsiteSourceUrl?: string;
  contactUpdatedAt?: string;
  lostFoundChannels?: PublishedLostFoundChannel[];
  lostFoundResponsibility?: ResolvedLostFoundResponsibility;
  keywords: string;
}

export interface SourceIndex {
  items: SearchItem[];
  quickLines: SearchItem[]; // U-Bahn + S-Bahn, for one-tap adding
  quickVenues: SearchItem[]; // famous sights, for one-tap adding
  dataUpdate: DataUpdateStatus;
}

export interface DataUpdateStatus {
  source: "remote" | "cache" | "worker" | "bundled";
  generatedAt: string;
  checkedAt: string;
  datasetVersion?: string;
  channelCount: number;
  reviewedVenueCount: number;
  warning?: string;
}

type TransitLineSummary = Pick<
  TransitLine,
  "id" | "mode" | "ref" | "name" | "color" | "textColor"
> & { operatorIds?: string[] };

interface TransitLineIndex {
  source: string;
  sourceUrl: string;
  sourceUpdatedAt: string;
  license: string;
  operators?: Record<string, string | TransitOperator>;
  lines: TransitLineSummary[];
}

// Famous Berlin sights (matched as lowercase substrings of the venue name),
// in the order they should appear as quick-add chips.
const POPULAR_VENUES = [
  "brandenburger tor",
  "reichstag",
  "fernsehturm",
  "museumsinsel",
  "berliner dom",
  "east side gallery",
  "checkpoint charlie",
  "gedächtniskirche",
  "potsdamer platz",
  "siegessäule",
];
const CENTRAL_BERLIN: LL = [52.52, 13.405];

function centralDistanceSquared(point?: LL): number {
  if (!point) return Number.POSITIVE_INFINITY;
  const latitudeScale = 111;
  const longitudeScale = 68;
  return (
    ((point[0] - CENTRAL_BERLIN[0]) * latitudeScale) ** 2 +
    ((point[1] - CENTRAL_BERLIN[1]) * longitudeScale) ** 2
  );
}

const MODE_RANK: Record<TransitMode, number> = {
  subway: 0,
  light_rail: 1,
  tram: 2,
  rail: 3,
  ferry: 4,
  bus: 5,
};

export async function fetchSources(): Promise<SourceIndex> {
  const [lineIndex, attractions, bundledChannels, bundledResponsibilities] = await Promise.all([
    fetchJson<TransitLineIndex>("/berlin-lines.json", "Berlin line index"),
    fetchJson<AttractionSet>("/berlin-attractions.json", "Berlin attractions"),
    fetchBundledChannelRegistry(),
    fetchBundledResponsibilityIndex(),
  ]);
  let remoteError: string | undefined;
  let remoteData;
  try {
    remoteData = await fetchRemoteLostFoundData();
  } catch (error) {
    remoteError =
      error instanceof Error
        ? error.message
        : "The update server could not be reached.";
    remoteData = await readCachedLostFoundData();
  }

  const bundledGeneratedAt = [
    bundledChannels?.generatedAt,
    bundledResponsibilities?.generatedAt,
  ]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? "1970-01-01T00:00:00.000Z";
  if (
    remoteData &&
    remoteData.manifest.generatedAt >= bundledGeneratedAt &&
    (!bundledChannels ||
      registryCoverageDoesNotRegress(remoteData.channels, bundledChannels))
  ) {
    return buildIndex(
      lineIndex.lines,
      attractions,
      lineIndex.operators,
      remoteData.channels,
      remoteData.responsibilities,
      {
        source: remoteData.source,
        generatedAt: remoteData.manifest.generatedAt,
        checkedAt: remoteData.checkedAt,
        datasetVersion: remoteData.manifest.datasetVersion,
        channelCount: remoteData.channels.channels.length,
        reviewedVenueCount:
          remoteData.manifest.summary?.reviewedVenues ??
          new Set(
            remoteData.channels.channels.flatMap((channel) => channel.venueIds)
          ).size,
        warning: remoteData.warning,
      }
    );
  }
  if (
    remoteData &&
    bundledChannels &&
    !registryCoverageDoesNotRegress(remoteData.channels, bundledChannels)
  ) {
    remoteError =
      "The downloaded update would reduce reviewed venue coverage and was ignored.";
  }

  const liveChannels = await fetchLiveChannelRegistry();
  const channelRegistry =
    liveChannels &&
    (!bundledChannels ||
      (liveChannels.generatedAt >= bundledChannels.generatedAt &&
        registryCoverageDoesNotRegress(liveChannels, bundledChannels)))
      ? liveChannels
      : bundledChannels;
  const source = liveChannels === channelRegistry ? "worker" : "bundled";
  const fallbackGeneratedAt = [
    channelRegistry?.generatedAt,
    bundledResponsibilities?.generatedAt,
  ]
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? bundledGeneratedAt;
  return buildIndex(
    lineIndex.lines,
    attractions,
    lineIndex.operators,
    channelRegistry,
    bundledResponsibilities,
    {
      source,
      generatedAt: fallbackGeneratedAt,
      checkedAt: new Date().toISOString(),
      channelCount: channelRegistry?.channels.length ?? 0,
      reviewedVenueCount: new Set(
        channelRegistry?.channels.flatMap((channel) => channel.venueIds) ?? []
      ).size,
      warning: remoteError
        ? `${remoteError} Using ${source === "worker" ? "the app service" : "built-in data"}.`
        : undefined,
    }
  );
}

export function registryCoverageDoesNotRegress(
  candidate: PublishedChannelRegistry,
  baseline: PublishedChannelRegistry
): boolean {
  const coveredVenues = (registry: PublishedChannelRegistry) =>
    new Set(registry.channels.flatMap((channel) => channel.venueIds)).size;
  return coveredVenues(candidate) >= coveredVenues(baseline);
}

let inferenceNetworkPromise: Promise<TransitNetwork> | null = null;

async function fetchJson<T>(url: string, label: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} could not be loaded (HTTP ${response.status}).`);
  }
  return (await response.json()) as T;
}

async function fetchBundledChannelRegistry(): Promise<
  PublishedChannelRegistry | undefined
> {
  try {
    const value = await fetchJson<unknown>(
      "/berlin-lost-found-channels.json",
      "Bundled channel registry"
    );
    return isPublishedChannelRegistry(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function fetchLiveChannelRegistry(): Promise<
  PublishedChannelRegistry | undefined
> {
  try {
    const value = await apiGetJson("/api/lost-found-channels");
    return isPublishedChannelRegistry(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function fetchBundledResponsibilityIndex(): Promise<
  PublicLostFoundResponsibilityIndex | undefined
> {
  try {
    const value = await fetchJson<unknown>(
      "/berlin-lost-found-responsibilities.json",
      "Bundled responsibility index"
    );
    return isPublicLostFoundResponsibilityIndex(value) ? value : undefined;
  } catch {
    // The reviewed channel registry and per-venue official links still work
    // when an older deployment does not yet contain the responsibility index.
    return undefined;
  }
}

/** Load the 2.9 MB geometry only after eligible photo anchors trigger route inference. */
export function fetchInferenceNetwork(): Promise<TransitNetwork> {
  if (!inferenceNetworkPromise) {
    inferenceNetworkPromise = fetchJson<TransitNetwork>(
      "/berlin-transit.json",
      "Offline transit geometry"
    ).catch((error) => {
      inferenceNetworkPromise = null;
      throw error;
    });
  }
  return inferenceNetworkPromise;
}

export function buildIndex(
  lines: TransitLineSummary[] | TransitNetwork,
  attractions: AttractionSet,
  operatorDirectory: Record<string, string | TransitOperator> = {},
  channelRegistry?: PublishedChannelRegistry,
  responsibilityIndex?: PublicLostFoundResponsibilityIndex,
  dataUpdate: DataUpdateStatus = {
    source: "bundled",
    generatedAt: channelRegistry?.generatedAt ?? "1970-01-01T00:00:00.000Z",
    checkedAt: new Date().toISOString(),
    channelCount: channelRegistry?.channels.length ?? 0,
    reviewedVenueCount: new Set(
      channelRegistry?.channels.flatMap((channel) => channel.venueIds) ?? []
    ).size,
  }
): SourceIndex {
  const sourceLines = Array.isArray(lines) ? lines : lines.lines;
  const lineItems: SearchItem[] = sourceLines.map((line) => ({
    kind: "line",
    refId: line.id,
    label: line.ref,
    sublabel: line.name,
    mode: line.mode,
    color: line.color,
    operators:
      "operators" in line && Array.isArray(line.operators)
        ? line.operators
        : "operatorIds" in line
          ? (line.operatorIds ?? []).map((id) => ({
              ...(typeof operatorDirectory[id] === "object"
                ? operatorDirectory[id]
                : { id, name: operatorDirectory[id] ?? id }),
              id,
            } as TransitOperator))
          : undefined,
    keywords: `${line.ref} ${line.name} ${
      "operatorIds" in line
        ? (line.operatorIds ?? [])
            .map((id) => {
              const operator = operatorDirectory[id];
              return typeof operator === "object" ? operator.name : operator ?? id;
            })
            .join(" ")
        : ""
    }`.toLowerCase(),
  }));

  const channelsByVenue = new Map<string, PublishedLostFoundChannel[]>();
  for (const channel of channelRegistry?.channels ?? []) {
    if (!isChannelReviewCurrent(channel)) continue;
    for (const venueId of channel.venueIds) {
      const existing = channelsByVenue.get(venueId) ?? [];
      existing.push(channel);
      channelsByVenue.set(venueId, existing);
    }
  }
  const channelRank: Record<PublishedLostFoundChannel["kind"], number> = {
    dedicated_lost_found_form: 0,
    operator_lost_found_form: 1,
    email: 2,
    phone: 3,
    general_contact_form: 4,
    central_office_fallback: 5,
  };
  for (const channels of channelsByVenue.values()) {
    channels.sort(
      (left, right) =>
        Number(isChannelReviewCurrent(right)) -
          Number(isChannelReviewCurrent(left)) ||
        Number(publishedChannelPurpose(left) !== "lost_property") -
          Number(publishedChannelPurpose(right) !== "lost_property") ||
        channelRank[left.kind] - channelRank[right.kind] ||
        right.verifiedAt.localeCompare(left.verifiedAt)
    );
  }
  const responsibilitiesById = new Map(
    (responsibilityIndex?.responsibilities ?? []).map((responsibility) => [
      responsibility.id,
      responsibility,
    ])
  );
  const assignmentsByVenue = new Map(
    (responsibilityIndex?.assignments ?? []).map((assignment) => [
      assignment.venueId,
      assignment,
    ])
  );
  const venueItems: SearchItem[] = attractions.attractions.map((a: Attraction) => {
    const venueChannels = channelsByVenue.get(a.id) ?? [];
    // A generic visitor-service form is a last resort. Once the same venue has
    // a purpose-bound form, email or phone, showing the generic form beside it
    // adds ambiguity and can route the traveller to an unrelated department.
    const hasPurposeBoundChannel = venueChannels.some(
      (channel) => publishedChannelPurpose(channel) === "lost_property"
    );
    const lostFoundChannels = hasPurposeBoundChannel
      ? venueChannels.filter(
          (channel) => publishedChannelPurpose(channel) === "lost_property"
        )
      : venueChannels;
    const primaryChannel = lostFoundChannels[0];
    const responsibilityAssignment = assignmentsByVenue.get(a.id);
    const responsibility = responsibilityAssignment
      ? responsibilitiesById.get(responsibilityAssignment.responsibilityId)
      : undefined;
    return {
      kind: "venue",
      refId: a.id,
      label: a.name,
      sublabel: CATEGORY_META[a.category].label,
      category: a.category,
      point: a.point,
      officialWebsite: a.website ?? a.operatorWebsite,
      officialPhone: a.phone,
      officialEmail: a.email,
      lostFoundUrl: primaryChannel?.pageUrl ?? a.lostFoundUrl,
      contactSourceUrl: a.contactSourceUrl,
      officialWebsiteSourceUrl: a.websiteSourceUrl,
      contactUpdatedAt: primaryChannel?.verifiedAt ?? a.contactUpdatedAt,
      lostFoundChannels,
      lostFoundResponsibility:
        responsibility && responsibilityAssignment
          ? { responsibility, assignment: responsibilityAssignment }
          : undefined,
      keywords: `${a.name} ${a.nameEn ?? ""}`.toLowerCase(),
    };
  });

  const quickLines = lineItems
    .filter((item) => item.mode === "subway" || item.mode === "light_rail")
    .sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }));

  const quickVenues: SearchItem[] = [];
  for (const key of POPULAR_VENUES) {
    // Prefer an exact-ish landmark over derivatives ("Potsdamer Platz" beats
    // "Das Center am Potsdamer Platz") by taking the shortest matching name.
    const match = venueItems
      .filter((v) => v.label.toLowerCase().includes(key))
      .sort((a, b) => {
        const aContact = a.officialWebsite ? 0 : 1;
        const bContact = b.officialWebsite ? 0 : 1;
        const ax = a.label.toLowerCase() === key ? 0 : 1;
        const bx = b.label.toLowerCase() === key ? 0 : 1;
        return (
          aContact - bContact ||
          ax - bx ||
          a.label.length - b.label.length ||
          centralDistanceSquared(a.point) - centralDistanceSquared(b.point)
        );
      })[0];
    if (match && !quickVenues.includes(match)) quickVenues.push(match);
  }

  return {
    items: [...lineItems, ...venueItems],
    quickLines,
    quickVenues,
    dataUpdate,
  };
}

/** Case-insensitive search across lines + venues, best matches first. */
export function searchItems(index: SourceIndex, query: string, limit = 40): SearchItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const scored: Array<{ item: SearchItem; score: number }> = [];
  for (const item of index.items) {
    const hit = item.keywords.indexOf(q);
    if (hit < 0) continue;
    // exact label match > label starts-with > early keyword hit; lines edge out venues.
    let score = hit;
    if (item.label.toLowerCase() === q) score -= 1000;
    else if (item.label.toLowerCase().startsWith(q)) score -= 500;
    if (item.kind === "line") score -= 20 - (MODE_RANK[item.mode!] ?? 5);
    scored.push({ item, score });
  }
  scored.sort((a, b) => a.score - b.score || a.item.label.length - b.item.label.length);
  return scored.slice(0, limit).map((s) => s.item);
}
