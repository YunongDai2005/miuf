import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildInventory } from "./inventory.mjs";
import { discoverChannels } from "./discovery.mjs";
import { mergeCandidateFiles } from "./merge.mjs";
import type { CandidateFile } from "./schemas";

const GOOGLE_NEARBY_URL =
  "https://places.googleapis.com/v1/places:searchNearby";
const GOOGLE_FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.location",
  "places.primaryType",
  "places.types",
  "places.websiteUri",
].join(",");

export const DEFAULT_GOOGLE_PLACE_TYPES = [
  "museum",
  "art_museum",
  "history_museum",
  "art_gallery",
  "castle",
  "cultural_landmark",
  "historical_place",
  "historical_landmark",
  "monument",
  "tourist_attraction",
  "observation_deck",
  "planetarium",
  "amusement_park",
  "aquarium",
  "botanical_garden",
  "wildlife_park",
  "zoo",
] as const;

export type GooglePlaceType = (typeof DEFAULT_GOOGLE_PLACE_TYPES)[number];

export interface AttractionSeed {
  id: string;
  name: string;
  nameEn?: string;
  category: string;
  point: [number, number];
  wikidata?: string;
  website?: string;
  operator?: string;
  operatorWebsite?: string;
  [key: string]: unknown;
}

export interface GooglePlaceSnapshot {
  id: string;
  displayName?: { text?: string };
  location?: { latitude?: number; longitude?: number };
  primaryType?: string;
  types?: string[];
  websiteUri?: string;
}

export interface AttractionMatch {
  placeId: string;
  venueId: string;
  venueIds: string[];
  score: number;
  distanceMeters: number;
  nameScore: number;
  websiteUri?: string;
}

type Bounds = {
  south: number;
  west: number;
  north: number;
  east: number;
};

type ScanCell = Bounds & { depth: number };

type GooglePlaceLinkFile = {
  version: 1;
  generatedAt: string;
  source: "Google Places API (New)";
  policy: string;
  links: Array<{
    placeId: string;
    venueIds: string[];
    matchedAt: string;
  }>;
  unmatchedPlaceIds: string[];
  crawlSeedPlaceIds: string[];
  pendingCanonicalizationPlaceIds: string[];
  summary: {
    apiRequests: number;
    uniquePlaces: number;
    matchedPlaces: number;
    officialWebsiteSeeds: number;
    matchedOfficialWebsiteSeeds: number;
    pendingCanonicalization: number;
    truncatedByRequestLimit: boolean;
  };
};

export interface GoogleWebsiteDiscoveryPlan {
  matches: AttractionMatch[];
  runtimeAttractions: AttractionSeed[];
  sourcePlaceIdsByRuntimeVenueId: Map<string, string[]>;
  openVenueIdsByRuntimeVenueId: Map<string, string[]>;
  crawlSeedPlaceIds: string[];
  pendingCanonicalizationPlaceIds: string[];
}

const BERLIN_BOUNDS: Bounds = {
  south: 52.3383,
  west: 13.0883,
  north: 52.6755,
  east: 13.7612,
};

const BLOCKED_WEBSITE_HOSTS = [
  "a.co",
  "amazon.com",
  "amazon.de",
  "facebook.com",
  "google.com",
  "google.de",
  "instagram.com",
  "linkedin.com",
  "odysee.com",
  "tiktok.com",
  "tripadvisor.com",
  "wikipedia.org",
  "x.com",
  "yelp.com",
  "youtu.be",
  "youtube.com",
];

function radians(value: number): number {
  return (value * Math.PI) / 180;
}

export function distanceMeters(
  left: [number, number],
  right: [number, number]
): number {
  const radius = 6_371_000;
  const latitudeDelta = radians(right[0] - left[0]);
  const longitudeDelta = radians(right[1] - left[1]);
  const leftLatitude = radians(left[0]);
  const rightLatitude = radians(right[0]);
  const value =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(leftLatitude) *
      Math.cos(rightLatitude) *
      Math.sin(longitudeDelta / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

const GENERIC_NAME_WORDS = new Set([
  "am",
  "an",
  "and",
  "berlin",
  "berliner",
  "das",
  "de",
  "der",
  "des",
  "die",
  "for",
  "fur",
  "für",
  "im",
  "in",
  "museum",
  "museums",
  "of",
  "the",
  "und",
  "von",
  "zu",
  "zur",
]);

function normalizedTokens(value: string): string[] {
  const tokens = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/ß/g, "ss")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const meaningful = tokens.filter((token) => !GENERIC_NAME_WORDS.has(token));
  return meaningful.length ? meaningful : tokens;
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(normalizedTokens(left));
  const rightTokens = new Set(normalizedTokens(right));
  if (!leftTokens.size || !rightTokens.size) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token));
  return (2 * intersection.length) / (leftTokens.size + rightTokens.size);
}

function compactName(value: string): string {
  return normalizedTokens(value).join("");
}

function bigrams(value: string): Set<string> {
  if (value.length < 2) return new Set(value ? [value] : []);
  const result = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) {
    result.add(value.slice(index, index + 2));
  }
  return result;
}

function bigramSimilarity(left: string, right: string): number {
  const leftBigrams = bigrams(compactName(left));
  const rightBigrams = bigrams(compactName(right));
  if (!leftBigrams.size || !rightBigrams.size) return 0;
  const intersection = [...leftBigrams].filter((value) =>
    rightBigrams.has(value)
  );
  return (2 * intersection.length) / (leftBigrams.size + rightBigrams.size);
}

export function venueNameSimilarity(left: string, right: string): number {
  return Math.max(tokenSimilarity(left, right), bigramSimilarity(left, right));
}

function compatibleCategory(category: string, types: string[]): boolean {
  const values = new Set(types);
  if (category === "museum") {
    return ["museum", "art_museum", "history_museum", "art_gallery", "planetarium"].some(
      (value) => values.has(value)
    );
  }
  if (category === "castle") return values.has("castle");
  if (category === "viewpoint") return values.has("observation_deck");
  if (category === "memorial") {
    return ["monument", "historical_place", "historical_landmark"].some(
      (value) => values.has(value)
    );
  }
  if (category === "leisure") {
    return [
      "amusement_park",
      "aquarium",
      "botanical_garden",
      "wildlife_park",
      "zoo",
    ].some((value) => values.has(value));
  }
  return [
    "cultural_landmark",
    "historical_place",
    "historical_landmark",
    "monument",
    "tourist_attraction",
  ].some((value) => values.has(value));
}

function validOfficialWebsite(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
      return undefined;
    }
    const hostname = url.hostname.replace(/^www\./i, "").toLowerCase();
    if (
      BLOCKED_WEBSITE_HOSTS.some(
        (blocked) => hostname === blocked || hostname.endsWith(`.${blocked}`)
      )
    ) {
      return undefined;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function canonicalWebsiteSeed(value: string): string {
  const url = new URL(value);
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

function normalizedWebsiteHost(value: string | undefined): string | undefined {
  const valid = validOfficialWebsite(value);
  if (!valid) return undefined;
  return new URL(valid).hostname.replace(/^www\./i, "").toLowerCase();
}

function categoryForGooglePlace(place: GooglePlaceSnapshot): string {
  const types = new Set(
    [place.primaryType, ...(place.types ?? [])].filter(
      (value): value is string => Boolean(value)
    )
  );
  if (
    ["museum", "art_museum", "history_museum", "art_gallery", "planetarium"].some(
      (value) => types.has(value)
    )
  ) {
    return "museum";
  }
  if (types.has("castle")) return "castle";
  if (types.has("observation_deck")) return "viewpoint";
  if (
    ["amusement_park", "aquarium", "botanical_garden", "wildlife_park", "zoo"].some(
      (value) => types.has(value)
    )
  ) {
    return "leisure";
  }
  if (
    ["monument", "historical_place", "historical_landmark"].some((value) =>
      types.has(value)
    )
  ) {
    return "memorial";
  }
  return "landmark";
}

function pendingRuntimeVenueId(placeId: string): string {
  return `google-place/${encodeURIComponent(placeId)}`;
}

function sourcePlaceIdsForVenueIds(
  venueIds: string[],
  sourcePlaceIdsByRuntimeVenueId: Map<string, string[]>
): string[] {
  return [
    ...new Set(
      venueIds.flatMap(
        (venueId) => sourcePlaceIdsByRuntimeVenueId.get(venueId) ?? []
      )
    ),
  ].sort();
}

function aliasesForAttraction(
  selected: AttractionSeed,
  attractions: AttractionSeed[]
): string[] {
  const normalizedSelectedName = compactName(selected.name);
  return attractions
    .filter((candidate) => {
      if (candidate.id === selected.id) return true;
      if (
        selected.wikidata &&
        candidate.wikidata &&
        selected.wikidata === candidate.wikidata
      ) {
        return true;
      }
      return (
        compactName(candidate.name) === normalizedSelectedName &&
        distanceMeters(selected.point, candidate.point) <= 60
      );
    })
    .map((candidate) => candidate.id)
    .sort();
}

export function matchGooglePlaceToAttraction(
  place: GooglePlaceSnapshot,
  attractions: AttractionSeed[]
): AttractionMatch | undefined {
  const name = place.displayName?.text?.trim();
  const latitude = place.location?.latitude;
  const longitude = place.location?.longitude;
  if (
    !place.id ||
    !name ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude)
  ) {
    return undefined;
  }
  const point: [number, number] = [latitude as number, longitude as number];
  const placeWebsiteHost = normalizedWebsiteHost(place.websiteUri);
  const placeTypes = [...new Set([place.primaryType, ...(place.types ?? [])].filter(
    (value): value is string => Boolean(value)
  ))];
  const ranked = attractions
    .map((attraction) => {
      const distance = distanceMeters(point, attraction.point);
      if (distance > 3_000) return undefined;
      const nameScore = Math.max(
        venueNameSimilarity(name, attraction.name),
        attraction.nameEn ? venueNameSimilarity(name, attraction.nameEn) : 0
      );
      const distanceScore =
        distance <= 40
          ? 1
          : distance <= 150
            ? 0.85
            : distance <= 500
              ? 0.55
              : distance <= 1_200
                ? 0.25
                : 0.05;
      const categoryScore = compatibleCategory(attraction.category, placeTypes)
        ? 1
        : 0;
      const attractionWebsiteHosts = [
        normalizedWebsiteHost(attraction.website),
        normalizedWebsiteHost(attraction.operatorWebsite),
      ].filter((value): value is string => Boolean(value));
      const websiteScore = Number(
        Boolean(
          placeWebsiteHost && attractionWebsiteHosts.includes(placeWebsiteHost)
        )
      );
      const score = Math.min(
        1,
        nameScore * 0.65 +
          distanceScore * 0.25 +
          categoryScore * 0.1 +
          websiteScore * 0.06
      );
      return { attraction, distance, nameScore, websiteScore, score };
    })
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    .sort(
      (left, right) =>
        right.score - left.score || left.distance - right.distance
    );
  const best = ranked[0];
  if (!best) return undefined;
  const acceptedByNameAndLocation =
    best.score >= 0.62 &&
    ((best.nameScore >= 0.55 && best.distance <= 1_200) ||
      (best.nameScore >= 0.35 && best.distance <= 150) ||
      (best.nameScore >= 0.82 && best.distance <= 3_000));
  const acceptedByWebsite =
    best.websiteScore === 1 &&
    best.score >= 0.58 &&
    best.nameScore >= 0.25 &&
    best.distance <= 1_200;
  if (!acceptedByNameAndLocation && !acceptedByWebsite) return undefined;
  const distinctRunnerUp = ranked.find(
    (entry) => {
      const sharesWikidata = Boolean(
        best.attraction.wikidata &&
          entry.attraction.wikidata &&
          best.attraction.wikidata === entry.attraction.wikidata
      );
      return (
        entry.attraction.id !== best.attraction.id &&
        !sharesWikidata &&
        !aliasesForAttraction(best.attraction, [entry.attraction]).includes(
          entry.attraction.id
        )
      );
    }
  );
  if (distinctRunnerUp && best.score - distinctRunnerUp.score < 0.08) {
    return undefined;
  }
  return {
    placeId: place.id,
    venueId: best.attraction.id,
    venueIds: aliasesForAttraction(best.attraction, attractions),
    score: Number(best.score.toFixed(4)),
    distanceMeters: Math.round(best.distance),
    nameScore: Number(best.nameScore.toFixed(4)),
    websiteUri: validOfficialWebsite(place.websiteUri),
  };
}

function splitCell(cell: ScanCell): ScanCell[] {
  const middleLatitude = (cell.south + cell.north) / 2;
  const middleLongitude = (cell.west + cell.east) / 2;
  const depth = cell.depth + 1;
  return [
    { south: cell.south, west: cell.west, north: middleLatitude, east: middleLongitude, depth },
    { south: cell.south, west: middleLongitude, north: middleLatitude, east: cell.east, depth },
    { south: middleLatitude, west: cell.west, north: cell.north, east: middleLongitude, depth },
    { south: middleLatitude, west: middleLongitude, north: cell.north, east: cell.east, depth },
  ];
}

function initialCells(bounds: Bounds, grid: number): ScanCell[] {
  const cells: ScanCell[] = [];
  const latitudeStep = (bounds.north - bounds.south) / grid;
  const longitudeStep = (bounds.east - bounds.west) / grid;
  for (let row = 0; row < grid; row += 1) {
    for (let column = 0; column < grid; column += 1) {
      cells.push({
        south: bounds.south + latitudeStep * row,
        north: bounds.south + latitudeStep * (row + 1),
        west: bounds.west + longitudeStep * column,
        east: bounds.west + longitudeStep * (column + 1),
        depth: 0,
      });
    }
  }
  return cells;
}

function cellCircle(cell: ScanCell): {
  center: { latitude: number; longitude: number };
  radius: number;
} {
  const center: [number, number] = [
    (cell.south + cell.north) / 2,
    (cell.west + cell.east) / 2,
  ];
  const corner: [number, number] = [cell.north, cell.east];
  return {
    center: { latitude: center[0], longitude: center[1] },
    radius: Math.min(50_000, Math.ceil(distanceMeters(center, corner) + 25)),
  };
}

function insideBounds(place: GooglePlaceSnapshot, bounds: Bounds): boolean {
  const latitude = place.location?.latitude;
  const longitude = place.location?.longitude;
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    (latitude as number) >= bounds.south &&
    (latitude as number) <= bounds.north &&
    (longitude as number) >= bounds.west &&
    (longitude as number) <= bounds.east
  );
}

async function sleep(milliseconds: number): Promise<void> {
  if (milliseconds <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function searchNearby(options: {
  apiKey: string;
  type: string;
  cell: ScanCell;
}): Promise<GooglePlaceSnapshot[]> {
  const response = await fetch(GOOGLE_NEARBY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": options.apiKey,
      "x-goog-fieldmask": GOOGLE_FIELD_MASK,
    },
    body: JSON.stringify({
      includedPrimaryTypes: [options.type],
      maxResultCount: 20,
      rankPreference: "POPULARITY",
      languageCode: "de",
      regionCode: "DE",
      locationRestriction: { circle: cellCircle(options.cell) },
    }),
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 1_000);
    throw new Error(`Google Places returned HTTP ${response.status}: ${body}`);
  }
  const payload = (await response.json()) as { places?: GooglePlaceSnapshot[] };
  return payload.places ?? [];
}

export async function scanGooglePlaces(options: {
  apiKey: string;
  types?: string[];
  bounds?: Bounds;
  grid?: number;
  maxDepth?: number;
  maxRequests?: number;
  delayMs?: number;
  onProgress?: (message: string) => void;
}): Promise<{
  places: GooglePlaceSnapshot[];
  apiRequests: number;
  truncatedByRequestLimit: boolean;
}> {
  if (!options.apiKey.trim()) throw new Error("Google Maps API key is required");
  const bounds = options.bounds ?? BERLIN_BOUNDS;
  const grid = Math.max(1, Math.min(8, options.grid ?? 2));
  const maxDepth = Math.max(0, Math.min(5, options.maxDepth ?? 3));
  const maxRequests = Math.max(1, options.maxRequests ?? 180);
  const types = [...new Set(options.types ?? [...DEFAULT_GOOGLE_PLACE_TYPES])];
  const byId = new Map<string, GooglePlaceSnapshot>();
  let apiRequests = 0;
  const queues = new Map(
    types.map((type) => [type, initialCells(bounds, grid)])
  );

  // Rotate across types instead of exhausting dense museum cells first. This
  // gives every requested category baseline coverage before recursive splits
  // consume the remaining request budget.
  while (apiRequests < maxRequests) {
    let scannedInRound = false;
    for (const type of types) {
      if (apiRequests >= maxRequests) break;
      const queue = queues.get(type)!;
      const cell = queue.shift();
      if (!cell) continue;
      scannedInRound = true;
      const places = await searchNearby({ apiKey: options.apiKey, type, cell });
      apiRequests += 1;
      for (const place of places) {
        if (place.id && insideBounds(place, bounds)) byId.set(place.id, place);
      }
      if (apiRequests % 10 === 0 || places.length === 20) {
        options.onProgress?.(
          `${type}: request ${apiRequests}, ${byId.size} unique Berlin places`
        );
      }
      if (places.length === 20 && cell.depth < maxDepth) {
        queue.push(...splitCell(cell));
      }
      await sleep(options.delayMs ?? 100);
    }
    if (!scannedInRound) break;
  }
  const truncatedByRequestLimit = [...queues.values()].some(
    (queue) => queue.length > 0
  );
  return {
    places: [...byId.values()],
    apiRequests,
    truncatedByRequestLimit,
  };
}

export function googleScanMinimumRequests(options?: {
  typeCount?: number;
  grid?: number;
}): number {
  const typeCount = options?.typeCount ?? DEFAULT_GOOGLE_PLACE_TYPES.length;
  const grid = options?.grid ?? 2;
  return typeCount * grid * grid;
}

/**
 * Build a runtime-only crawl inventory from Google website seeds.
 *
 * Matched places retain the existing open-data venue IDs. An unmatched place
 * receives a temporary ID containing only its cacheable Place ID; Google name,
 * coordinates, type and website never leave the runtime inventory.
 */
export function buildGoogleWebsiteDiscoveryPlan(
  places: GooglePlaceSnapshot[],
  attractions: AttractionSeed[]
): GoogleWebsiteDiscoveryPlan {
  const matches: AttractionMatch[] = [];
  const runtimeByVenueId = new Map<
    string,
    { attraction: AttractionSeed; matchScore: number }
  >();
  const sourcePlaceIdsByRuntimeVenueId = new Map<string, string[]>();
  const openVenueIdsByRuntimeVenueId = new Map<string, string[]>();
  const pendingRuntimeVenueIdByWebsite = new Map<string, string>();
  const crawlSeedPlaceIds = new Set<string>();
  const pendingCanonicalizationPlaceIds = new Set<string>();
  const attractionsById = new Map(
    attractions.map((attraction) => [attraction.id, attraction])
  );

  const addSourcePlaceId = (runtimeVenueId: string, placeId: string) => {
    const current = sourcePlaceIdsByRuntimeVenueId.get(runtimeVenueId) ?? [];
    if (!current.includes(placeId)) current.push(placeId);
    sourcePlaceIdsByRuntimeVenueId.set(runtimeVenueId, current);
  };

  for (const place of places) {
    const match = matchGooglePlaceToAttraction(place, attractions);
    if (match) matches.push(match);
    const website = validOfficialWebsite(place.websiteUri);
    if (!website) continue;
    const name = place.displayName?.text?.trim();
    const latitude = place.location?.latitude;
    const longitude = place.location?.longitude;
    if (
      !place.id ||
      !name ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude)
    ) {
      continue;
    }
    crawlSeedPlaceIds.add(place.id);

    if (match) {
      for (const venueId of match.venueIds) {
        const attraction = attractionsById.get(venueId);
        if (!attraction) continue;
        const current = runtimeByVenueId.get(venueId);
        if (!current || match.score > current.matchScore) {
          runtimeByVenueId.set(venueId, {
            attraction: { ...attraction, website },
            matchScore: match.score,
          });
        }
        addSourcePlaceId(venueId, place.id);
        openVenueIdsByRuntimeVenueId.set(venueId, [venueId]);
      }
      continue;
    }

    pendingCanonicalizationPlaceIds.add(place.id);
    const websiteKey = canonicalWebsiteSeed(website);
    const runtimeVenueId =
      pendingRuntimeVenueIdByWebsite.get(websiteKey) ??
      pendingRuntimeVenueId(place.id);
    pendingRuntimeVenueIdByWebsite.set(websiteKey, runtimeVenueId);
    if (!runtimeByVenueId.has(runtimeVenueId)) {
      runtimeByVenueId.set(runtimeVenueId, {
        attraction: {
          id: runtimeVenueId,
          name,
          category: categoryForGooglePlace(place),
          point: [latitude as number, longitude as number],
          website,
        },
        matchScore: 0,
      });
      openVenueIdsByRuntimeVenueId.set(runtimeVenueId, []);
    }
    addSourcePlaceId(runtimeVenueId, place.id);
  }

  return {
    matches,
    runtimeAttractions: [...runtimeByVenueId.values()].map(
      (entry) => entry.attraction
    ),
    sourcePlaceIdsByRuntimeVenueId,
    openVenueIdsByRuntimeVenueId,
    crawlSeedPlaceIds: [...crawlSeedPlaceIds].sort(),
    pendingCanonicalizationPlaceIds: [
      ...pendingCanonicalizationPlaceIds,
    ].sort(),
  };
}

/**
 * Remove runtime-only Google venue records from the durable candidate file.
 * Pending candidates keep Place IDs for later canonicalization but cannot be
 * accepted or published until an open-data venue assignment is supplied.
 */
export function finalizeGoogleCandidateFile(
  file: CandidateFile,
  plan: GoogleWebsiteDiscoveryPlan
): CandidateFile {
  const candidates = file.candidates.map((candidate) => {
    const sourcePlaceIds = sourcePlaceIdsForVenueIds(
      candidate.venueIds,
      plan.sourcePlaceIdsByRuntimeVenueId
    );
    const venueIds = [
      ...new Set(
        candidate.venueIds.flatMap(
          (venueId) => plan.openVenueIdsByRuntimeVenueId.get(venueId) ?? []
        )
      ),
    ].sort();
    const canonicalizationStatus = venueIds.length ? "mapped" : "pending";
    const reasons = [...candidate.reasons];
    if (canonicalizationStatus === "pending") {
      reasons.push(
        "Google Place website was crawled, but the place is not yet mapped to the open venue index"
      );
    }
    return {
      ...candidate,
      venueIds,
      sourcePlaceIds,
      canonicalizationStatus,
      reasons: [...new Set(reasons)],
      discoveryPath: candidate.discoveryPath.map((step, index) =>
        index === 0 && /official website/i.test(step.label)
          ? {
              ...step,
              label: "official website seed fetched via Google Places API",
            }
          : step
      ),
      reviewStatus:
        canonicalizationStatus === "pending"
          ? "needs_review"
          : candidate.reviewStatus,
    } satisfies CandidateFile["candidates"][number];
  });
  const failures = file.failures.map((failure) => {
    const sourcePlaceIds = sourcePlaceIdsForVenueIds(
      failure.venueIds,
      plan.sourcePlaceIdsByRuntimeVenueId
    );
    const venueIds = [
      ...new Set(
        failure.venueIds.flatMap(
          (venueId) => plan.openVenueIdsByRuntimeVenueId.get(venueId) ?? []
        )
      ),
    ].sort();
    return {
      ...failure,
      seedUrl: sourcePlaceIds.length
        ? `google-place:${sourcePlaceIds.join(",")}`
        : "google-place:unknown",
      venueIds,
      sourcePlaceIds,
    };
  });
  return {
    version: 1,
    generatedAt: file.generatedAt,
    candidates,
    failures,
  };
}

export async function discoverGoogleSeededChannels(options: {
  apiKey: string;
  attractionPath: string;
  operatorOverridePath: string;
  linkOutputPath: string;
  candidateOutputPath: string;
  types?: string[];
  grid?: number;
  maxDepth?: number;
  maxRequests?: number;
  googleDelayMs?: number;
  maxPagesPerDomain?: number;
  crawlDepth?: number;
  crawlDelayMs?: number;
  crawlShards?: number;
  renderDynamic?: boolean;
  resume?: boolean;
  checkpoint?: boolean;
  onProgress?: (message: string) => void;
}): Promise<{
  links: GooglePlaceLinkFile;
  candidates: CandidateFile;
}> {
  const source = JSON.parse(await readFile(options.attractionPath, "utf8")) as {
    attractions: AttractionSeed[];
    [key: string]: unknown;
  };
  const scan = await scanGooglePlaces({
    apiKey: options.apiKey,
    types: options.types,
    grid: options.grid,
    maxDepth: options.maxDepth,
    maxRequests: options.maxRequests,
    delayMs: options.googleDelayMs,
    onProgress: options.onProgress,
  });
  const plan = buildGoogleWebsiteDiscoveryPlan(
    scan.places,
    source.attractions
  );
  const matchedPlaceIds = new Set(
    plan.matches.map((match) => match.placeId)
  );
  const crawlSeedPlaceIds = new Set(plan.crawlSeedPlaceIds);
  const matchedAt = new Date().toISOString();
  const links: GooglePlaceLinkFile = {
    version: 1,
    generatedAt: matchedAt,
    source: "Google Places API (New)",
    policy:
      "Only Google Place IDs and open-index links are retained from Google. Names, coordinates, types and website values are runtime-only; durable channel URLs and evidence come from pages independently fetched from venue websites.",
    links: plan.matches
      .map((match) => ({
        placeId: match.placeId,
        venueIds: match.venueIds,
        matchedAt,
      }))
      .sort((left, right) => left.placeId.localeCompare(right.placeId)),
    unmatchedPlaceIds: scan.places
      .map((place) => place.id)
      .filter((placeId) => placeId && !matchedPlaceIds.has(placeId))
      .sort(),
    crawlSeedPlaceIds: plan.crawlSeedPlaceIds,
    pendingCanonicalizationPlaceIds:
      plan.pendingCanonicalizationPlaceIds,
    summary: {
      apiRequests: scan.apiRequests,
      uniquePlaces: scan.places.length,
      matchedPlaces: plan.matches.length,
      officialWebsiteSeeds: plan.crawlSeedPlaceIds.length,
      matchedOfficialWebsiteSeeds: plan.matches.filter((match) =>
        crawlSeedPlaceIds.has(match.placeId)
      ).length,
      pendingCanonicalization:
        plan.pendingCanonicalizationPlaceIds.length,
      truncatedByRequestLimit: scan.truncatedByRequestLimit,
    },
  };
  await mkdir(dirname(options.linkOutputPath), { recursive: true });
  await writeFile(options.linkOutputPath, `${JSON.stringify(links, null, 2)}\n`);

  if (!plan.runtimeAttractions.length) {
    const emptyCandidates: CandidateFile = {
      version: 1,
      generatedAt: new Date().toISOString(),
      candidates: [],
      failures: [],
    };
    await mkdir(dirname(options.candidateOutputPath), { recursive: true });
    await writeFile(
      options.candidateOutputPath,
      `${JSON.stringify(emptyCandidates, null, 2)}\n`
    );
    return { links, candidates: emptyCandidates };
  }

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "berlin-lost-found-google-")
  );
  try {
    const temporaryAttractions = join(temporaryDirectory, "attractions.json");
    const temporaryInventory = join(temporaryDirectory, "inventory.json");
    const crawlShards = Math.max(
      1,
      Math.min(8, Math.floor(options.crawlShards ?? 4))
    );
    await writeFile(
      temporaryAttractions,
      `${JSON.stringify({
        source:
          "Runtime Google Places website seeds; Google fields are not persisted",
        attractions: plan.runtimeAttractions,
      })}\n`
    );
    await buildInventory({
      inputPath: temporaryAttractions,
      outputPath: temporaryInventory,
      sourceLabel: "runtime Google Places seed (not persisted)",
      operatorOverridePath: options.operatorOverridePath,
    });
    if (options.resume) {
      options.onProgress?.(
        "Google discovery uses a private temporary crawl inventory, so durable resume checkpoints are intentionally disabled."
      );
    }
    const shardOutputs = await Promise.all(
      Array.from({ length: crawlShards }, async (_, shardIndex) => {
        const outputPath = join(
          temporaryDirectory,
          `candidates-shard-${shardIndex}.json`
        );
        await discoverChannels({
          inventoryPath: temporaryInventory,
          outputPath,
          maxPagesPerDomain: options.maxPagesPerDomain ?? 20,
          maxDepth: options.crawlDepth ?? 2,
          delayMs: options.crawlDelayMs ?? 900,
          shardIndex,
          shardCount: crawlShards,
          renderDynamic: options.renderDynamic,
          resume: false,
          checkpoint: Boolean(options.checkpoint),
          onProgress: (message) =>
            options.onProgress?.(`[crawl ${shardIndex + 1}/${crawlShards}] ${message}`),
        });
        return outputPath;
      })
    );
    const runtimeCandidates =
      shardOutputs.length === 1
        ? (JSON.parse(await readFile(shardOutputs[0], "utf8")) as CandidateFile)
        : await mergeCandidateFiles({
            inputPaths: shardOutputs,
            outputPath: join(temporaryDirectory, "candidates-merged.json"),
          });
    const candidates = finalizeGoogleCandidateFile(runtimeCandidates, plan);
    await mkdir(dirname(options.candidateOutputPath), { recursive: true });
    await writeFile(
      options.candidateOutputPath,
      `${JSON.stringify(candidates, null, 2)}\n`
    );
    return { links, candidates };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
