// Berlin sightseeing spots bundled in /berlin-attractions.json (OSM/Overpass).

export type AttractionCategory =
  | "landmark"
  | "museum"
  | "viewpoint"
  | "castle"
  | "leisure"
  | "ruins"
  | "memorial"
  | "artwork"
  // Staffed places with a ticket desk and a cloakroom. A concert hall empties
  // several thousand people in ten minutes and has to have somewhere for the
  // coats left behind, which is why these publish lost-property information far
  // more often than a sculpture or a small museum does.
  | "venue"
  | "theatre"
  | "cinema"
  | "stadium"
  | "gallery"
  | "library";

export interface Attraction {
  id: string;
  name: string;
  nameEn?: string;
  category: AttractionCategory;
  point: [number, number]; // [lat, lng]
  wikidata?: string;
  wikipedia?: string;
  /** Contact candidates imported from OSM. They are shown as unverified until curated. */
  website?: string;
  phone?: string;
  email?: string;
  operator?: string;
  operatorWebsite?: string;
  lostFoundUrl?: string;
  contactSourceUrl?: string;
  websiteSourceUrl?: string;
  contactUpdatedAt?: string;
}

export interface AttractionSet {
  source: string;
  sourceUrl: string;
  license: string;
  attractions: Attraction[];
}

export interface CategoryMeta {
  label: string;
  emoji: string;
  color: string;
  /** Whether the category is shown by default (noisy ones start hidden). */
  defaultOn: boolean;
}

// Order here drives the legend / filter chips.
export const ATTRACTION_CATEGORIES: AttractionCategory[] = [
  "landmark",
  "museum",
  "venue",
  "theatre",
  "cinema",
  "stadium",
  "gallery",
  "library",
  "viewpoint",
  "castle",
  "leisure",
  "ruins",
  "memorial",
  "artwork",
];

export const CATEGORY_META: Record<AttractionCategory, CategoryMeta> = {
  landmark: { label: "地标景点", emoji: "⭐", color: "#E11D48", defaultOn: true },
  museum: { label: "博物馆", emoji: "🏛️", color: "#7C3AED", defaultOn: true },
  viewpoint: { label: "观景台", emoji: "🔭", color: "#0EA5E9", defaultOn: true },
  castle: { label: "宫殿城堡", emoji: "🏰", color: "#9333EA", defaultOn: true },
  leisure: { label: "动物园·乐园", emoji: "🎡", color: "#16A34A", defaultOn: true },
  ruins: { label: "遗址", emoji: "🏺", color: "#A16207", defaultOn: true },
  memorial: { label: "纪念场所", emoji: "🕯️", color: "#64748B", defaultOn: false },
  artwork: { label: "公共艺术", emoji: "🎨", color: "#DB2777", defaultOn: false },
  venue: { label: "演出场馆", emoji: "🎤", color: "#F97316", defaultOn: true },
  theatre: { label: "剧院", emoji: "🎭", color: "#C026D3", defaultOn: true },
  cinema: { label: "影院", emoji: "🎬", color: "#0891B2", defaultOn: true },
  stadium: { label: "体育场馆", emoji: "🏟️", color: "#059669", defaultOn: true },
  gallery: { label: "美术馆", emoji: "🖼️", color: "#8B5CF6", defaultOn: true },
  library: { label: "图书馆", emoji: "📚", color: "#0F766E", defaultOn: false },
};

export type CategoryFilter = Record<AttractionCategory, boolean>;

export const INITIAL_CATEGORY_FILTER: CategoryFilter = ATTRACTION_CATEGORIES.reduce(
  (filter, category) => {
    filter[category] = CATEGORY_META[category].defaultOn;
    return filter;
  },
  {} as CategoryFilter
);

/** Build a Wikipedia/Wikidata URL from OSM tags, or null when unavailable. */
export function attractionWikiUrl(attraction: Attraction): string | null {
  const { wikipedia, wikidata } = attraction;
  if (wikipedia) {
    const separator = wikipedia.indexOf(":");
    if (separator > 0) {
      const lang = wikipedia.slice(0, separator);
      const title = wikipedia.slice(separator + 1);
      return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(
        title.replace(/ /g, "_")
      )}`;
    }
  }
  if (wikidata) return `https://www.wikidata.org/wiki/${wikidata}`;
  return null;
}
