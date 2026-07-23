import type { LL } from "../berlin-transit/geo";
import type {
  TransitLine,
  TransitMode,
  TransitNetwork,
} from "../berlin-transit/transit";
import {
  CATEGORY_META,
  type Attraction,
  type AttractionCategory,
  type AttractionSet,
} from "../berlin-transit/attractions";
import type { ItineraryJourney } from "./types";

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
  keywords: string;
}

export interface SourceIndex {
  items: SearchItem[];
  quickLines: SearchItem[]; // U-Bahn + S-Bahn, for one-tap adding
  quickVenues: SearchItem[]; // famous sights, for one-tap adding
}

type TransitLineSummary = Pick<
  TransitLine,
  "id" | "mode" | "ref" | "name" | "color" | "textColor"
>;

interface TransitLineIndex {
  source: string;
  sourceUrl: string;
  sourceUpdatedAt: string;
  license: string;
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

const MODE_RANK: Record<TransitMode, number> = {
  subway: 0,
  light_rail: 1,
  tram: 2,
  rail: 3,
  ferry: 4,
  bus: 5,
};

export async function fetchSources(): Promise<SourceIndex> {
  const [lineIndex, attractions] = await Promise.all([
    fetchJson<TransitLineIndex>("/berlin-lines.json", "Berlin line index"),
    fetchJson<AttractionSet>("/berlin-attractions.json", "Berlin attractions"),
  ]);
  return buildIndex(lineIndex.lines, attractions);
}

let inferenceNetworkPromise: Promise<TransitNetwork> | null = null;

async function fetchJson<T>(url: string, label: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${label} could not be loaded (HTTP ${response.status}).`);
  }
  return (await response.json()) as T;
}

/** Load the 2.9 MB geometry only after the traveller explicitly asks for route inference. */
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
  attractions: AttractionSet
): SourceIndex {
  const sourceLines = Array.isArray(lines) ? lines : lines.lines;
  const lineItems: SearchItem[] = sourceLines.map((line) => ({
    kind: "line",
    refId: line.id,
    label: line.ref,
    sublabel: line.name,
    mode: line.mode,
    color: line.color,
    keywords: `${line.ref} ${line.name}`.toLowerCase(),
  }));

  const venueItems: SearchItem[] = attractions.attractions.map((a: Attraction) => ({
    kind: "venue",
    refId: a.id,
    label: a.name,
    sublabel: CATEGORY_META[a.category].label,
    category: a.category,
    point: a.point,
    keywords: `${a.name} ${a.nameEn ?? ""}`.toLowerCase(),
  }));

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
        const ax = a.label.toLowerCase() === key ? 0 : 1;
        const bx = b.label.toLowerCase() === key ? 0 : 1;
        return ax - bx || a.label.length - b.label.length;
      })[0];
    if (match && !quickVenues.includes(match)) quickVenues.push(match);
  }

  return { items: [...lineItems, ...venueItems], quickLines, quickVenues };
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
