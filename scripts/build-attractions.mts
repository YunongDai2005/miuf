/**
 * Rebuilds public/berlin-attractions.json from OpenStreetMap.
 *
 * The index began as a sightseeing list, which suited naming where a
 * photograph was taken but not finding a lost-property route: measured over
 * 177 venue websites, tourism objects publish one 5.6 per cent of the time,
 * while the three concert venues checked by hand all did. What separates them
 * is staff — a ticket desk, a cloakroom, and several thousand people leaving at
 * once — so the staffed categories are now queried too.
 *
 * Entries already in the file keep any curated fields, since some carry a
 * hand-checked lostFoundUrl that no query would reproduce.
 *
 *   node --import tsx scripts/build-attractions.mts [--dry-run]
 */
import { readFile, writeFile } from "node:fs/promises";
import type {
  Attraction,
  AttractionCategory,
  AttractionSet,
} from "../app/berlin-transit/attractions";

const OUTPUT = "public/berlin-attractions.json";

/** OSM selectors per category, in the order a place should be classified. */
const SELECTORS: Array<{ category: AttractionCategory; filters: string[] }> = [
  { category: "venue", filters: ['["amenity"="events_venue"]', '["amenity"="nightclub"]', '["amenity"="music_venue"]', '["amenity"="conference_centre"]'] },
  { category: "theatre", filters: ['["amenity"="theatre"]'] },
  { category: "cinema", filters: ['["amenity"="cinema"]'] },
  { category: "stadium", filters: ['["leisure"="stadium"]', '["leisure"="sports_centre"]', '["leisure"="ice_rink"]'] },
  { category: "gallery", filters: ['["tourism"="gallery"]'] },
  { category: "library", filters: ['["amenity"="library"]'] },
  { category: "museum", filters: ['["tourism"="museum"]'] },
  { category: "leisure", filters: ['["tourism"="zoo"]', '["tourism"="aquarium"]', '["tourism"="theme_park"]'] },
  { category: "castle", filters: ['["historic"="castle"]', '["historic"="palace"]'] },
  { category: "viewpoint", filters: ['["tourism"="viewpoint"]'] },
  { category: "ruins", filters: ['["historic"="ruins"]'] },
  // historic=memorial covers Berlin's Stolpersteine, thousands of brass plaques
  // set into pavements. They are places a photograph can be named after, but
  // adding seven thousand of them drowns the index; only the monuments a
  // visitor would recognise are kept.
  { category: "memorial", filters: ['["historic"="monument"]'] },
  { category: "artwork", filters: ['["tourism"="artwork"]'] },
  { category: "landmark", filters: ['["tourism"="attraction"]', '["historic"="building"]'] },
];

type OsmElement = {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One category at a time: asking for every selector at once times out. */
async function fetchGroup(filters: string[]): Promise<OsmElement[]> {
  const body = [
    "[out:json][timeout:180];",
    'area["name"="Berlin"]["boundary"="administrative"]["admin_level"="4"]->.b;',
    "(",
    ...filters.map((filter) => `nwr(area.b)${filter};`),
    ");",
    "out tags center;",
  ].join("");

  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    for (const endpoint of ENDPOINTS) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
            "user-agent": "Berlin-Lost-and-Found-data-builder/1.0",
          },
          body: new URLSearchParams({ data: body }),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        if (!text.trimStart().startsWith("{")) throw new Error("non-JSON body");
        return (JSON.parse(text) as { elements?: OsmElement[] }).elements ?? [];
      } catch (error) {
        lastError = error;
        await sleep(3_000);
      }
    }
  }
  console.warn(`  ! ${filters[0]} failed: ${String(lastError).slice(0, 60)}`);
  return [];
}

async function fetchElements(): Promise<OsmElement[]> {
  const all: OsmElement[] = [];
  for (const { category, filters } of SELECTORS) {
    const group = await fetchGroup(filters);
    console.log(`  ${category.padEnd(10)} ${String(group.length).padStart(5)}`);
    all.push(...group);
    await sleep(1_200); // the public endpoint asks for a gap between queries
  }
  return all;
}

function categoryOf(tags: Record<string, string>): AttractionCategory | undefined {
  for (const { category, filters } of SELECTORS) {
    for (const filter of filters) {
      const match = /\["([^"]+)"="([^"]+)"\]/.exec(filter);
      if (match && tags[match[1]] === match[2]) return category;
    }
  }
  return undefined;
}

const webUrl = (value?: string): string | undefined => {
  if (!value) return undefined;
  const raw = value.split(";")[0].trim();
  if (!raw) return undefined;
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
};

const existing = JSON.parse(await readFile(OUTPUT, "utf8")) as AttractionSet;
const curated = new Map(existing.attractions.map((a) => [a.id, a]));

const elements = await fetchElements();
console.log(`Overpass returned ${elements.length} elements`);

const built = new Map<string, Attraction>();
for (const element of elements) {
  const tags = element.tags ?? {};
  const name = tags.name?.trim();
  if (!name) continue;
  const category = categoryOf(tags);
  if (!category) continue;
  // A plaque set into the pavement is not somewhere anything is handed in.
  if (category === "memorial" && (tags.memorial === "stolperstein" || tags["memorial:type"] === "stolperstein")) {
    continue;
  }
  const lat = element.lat ?? element.center?.lat;
  const lon = element.lon ?? element.center?.lon;
  if (typeof lat !== "number" || typeof lon !== "number") continue;

  const id = `${element.type}/${element.id}`;
  const previous = curated.get(id);
  built.set(id, {
    // Curated values win: a hand-checked lostFoundUrl is not in OSM.
    ...previous,
    id,
    name,
    nameEn: tags["name:en"] || previous?.nameEn,
    category,
    point: [Number(lat.toFixed(5)), Number(lon.toFixed(5))],
    wikidata: tags.wikidata || previous?.wikidata,
    wikipedia: tags.wikipedia || previous?.wikipedia,
    website: webUrl(tags["contact:website"] ?? tags.website ?? tags.url) ?? previous?.website,
    phone: (tags["contact:phone"] ?? tags.phone)?.split(";")[0].trim() || previous?.phone,
    email: (tags["contact:email"] ?? tags.email)?.split(";")[0].trim() || previous?.email,
    operator: tags.operator || previous?.operator,
  });
}

// Anything curated that the query no longer returns is kept: a place removed
// from OSM has not necessarily closed, and its reviewed channel is still valid.
let retained = 0;
for (const [id, attraction] of curated) {
  if (!built.has(id)) {
    built.set(id, attraction);
    retained += 1;
  }
}

const attractions = [...built.values()].sort((a, b) => a.id.localeCompare(b.id));
const byCategory = attractions.reduce<Record<string, number>>((acc, a) => {
  acc[a.category] = (acc[a.category] ?? 0) + 1;
  return acc;
}, {});

console.log(`\nbefore ${existing.attractions.length} -> after ${attractions.length}`);
console.log(`  retained from the previous file  ${retained}`);
console.log(`  with a website                   ${attractions.filter((a) => a.website).length}`);
console.log(`  with a phone or email            ${attractions.filter((a) => a.phone || a.email).length}`);
console.log("\nby category:");
for (const [category, count] of Object.entries(byCategory).sort((a, b) => b[1] - a[1])) {
  const before = existing.attractions.filter((a) => a.category === category).length;
  console.log(`  ${category.padEnd(10)} ${String(count).padStart(5)}  (was ${before})`);
}

if (process.argv.includes("--dry-run")) {
  console.log("\nDry run; nothing written.");
} else {
  await writeFile(
    OUTPUT,
    `${JSON.stringify({ ...existing, attractions }, null, 1)}\n`
  );
  console.log(`\nwritten to ${OUTPUT}`);
}
