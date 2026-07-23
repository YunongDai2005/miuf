import { readFile, writeFile } from "node:fs/promises";

type Attraction = {
  id: string;
  wikidata?: string;
  website?: string;
  phone?: string;
  email?: string;
  operator?: string;
  operatorWebsite?: string;
  contactSourceUrl?: string;
  websiteSourceUrl?: string;
  contactUpdatedAt?: string;
  [key: string]: unknown;
};

type AttractionSet = {
  attractions: Attraction[];
  [key: string]: unknown;
};

type OsmElement = {
  type: "node" | "way" | "relation";
  id: number;
  tags?: Record<string, string>;
};

const input = new URL("../public/berlin-attractions.json", import.meta.url);
const data = JSON.parse(await readFile(input, "utf8")) as AttractionSet;
const ids = {
  node: [] as string[],
  way: [] as string[],
  relation: [] as string[],
};

for (const attraction of data.attractions) {
  const [type, id] = attraction.id.split("/");
  if ((type === "node" || type === "way" || type === "relation") && /^\d+$/.test(id)) {
    ids[type].push(id);
  }
}

const query = [
  "[out:json][timeout:180];",
  ids.node.length ? `node(id:${ids.node.join(",")});` : "",
  ids.way.length ? `way(id:${ids.way.join(",")});` : "",
  ids.relation.length ? `rel(id:${ids.relation.join(",")});` : "",
  "out tags;",
].join("");

const endpoints = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

async function fetchElements(): Promise<OsmElement[]> {
  let lastError: unknown;
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
          "user-agent": "Berlin-Lost-and-Found-data-builder/1.0",
        },
        body: new URLSearchParams({ data: query }),
      });
      if (!response.ok) throw new Error(`${endpoint} returned HTTP ${response.status}`);
      const payload = (await response.json()) as { elements?: OsmElement[] };
      return payload.elements ?? [];
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Overpass request failed.");
}

function firstValue(...values: Array<string | undefined>): string | undefined {
  return values
    .flatMap((value) => value?.split(";") ?? [])
    .map((value) => value.trim())
    .find(Boolean);
}

function webUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const candidate = value.match(/^https?:\/\//i)
    ? value
    : value.match(/^www\./i)
      ? `https://${value}`
      : undefined;
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

let osmElements: OsmElement[] = [];
if (!process.argv.includes("--wikidata-only")) {
  try {
    osmElements = await fetchElements();
  } catch (error) {
    console.warn(
      `Overpass was unavailable; keeping existing OSM contacts and continuing with Wikidata (${error instanceof Error ? error.message : "unknown error"}).`
    );
  }
}
const byId = new Map(
  osmElements.map((element) => [`${element.type}/${element.id}`, element.tags ?? {}])
);
const updatedAt = new Date().toISOString().slice(0, 10);
let enriched = 0;
let osmWebsites = 0;

for (const attraction of data.attractions) {
  const tags = byId.get(attraction.id);
  if (!tags) continue;
  const website = webUrl(firstValue(tags["contact:website"], tags.website, tags.url));
  const operatorWebsite = webUrl(
    firstValue(tags["operator:website"], tags["contact:operator:website"])
  );
  const phone = firstValue(tags["contact:phone"], tags.phone);
  const email = firstValue(tags["contact:email"], tags.email);
  const operator = firstValue(tags.operator, tags.brand);
  if (!website && !operatorWebsite && !phone && !email && !operator) continue;
  if (website) {
    attraction.website = website;
    attraction.websiteSourceUrl = `https://www.openstreetmap.org/${attraction.id}`;
    osmWebsites += 1;
  }
  if (operatorWebsite) {
    attraction.operatorWebsite = operatorWebsite;
    attraction.websiteSourceUrl = `https://www.openstreetmap.org/${attraction.id}`;
    osmWebsites += 1;
  }
  if (phone) attraction.phone = phone;
  if (email) attraction.email = email;
  if (operator) attraction.operator = operator;
  attraction.contactSourceUrl = `https://www.openstreetmap.org/${attraction.id}`;
  attraction.contactUpdatedAt = updatedAt;
  enriched += 1;
}

const missingWebsite = data.attractions.filter(
  (attraction) =>
    !attraction.website &&
    !attraction.operatorWebsite &&
    typeof attraction.wikidata === "string" &&
    /^Q\d+$/.test(attraction.wikidata)
);
const uniqueEntityIds = [
  ...new Set(missingWebsite.map((attraction) => attraction.wikidata as string)),
];
const wikidataBatches: string[][] = [];
for (let index = 0; index < uniqueEntityIds.length; index += 250) {
  wikidataBatches.push(uniqueEntityIds.slice(index, index + 250));
}

const websitesByEntity = new Map<string, string>();
let wikidataWebsites = 0;
for (const entityIds of wikidataBatches) {
  const query = `SELECT ?item ?website WHERE { VALUES ?item { ${entityIds
    .map((id) => `wd:${id}`)
    .join(" ")} } ?item wdt:P856 ?website. }`;
  const url = new URL("https://query.wikidata.org/sparql");
  url.search = new URLSearchParams({
    format: "json",
    query,
  }).toString();
  let response: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    response = await fetch(url, {
      headers: { "user-agent": "Berlin-Lost-and-Found-data-builder/1.0" },
    });
    if (response.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
  }
  if (!response?.ok) {
    throw new Error(`Wikidata returned HTTP ${response?.status ?? "unknown"}`);
  }
  const payload = (await response.json()) as {
    results?: {
      bindings?: Array<{
        item?: { value?: string };
        website?: { value?: string };
      }>;
    };
  };
  for (const binding of payload.results?.bindings ?? []) {
    const entityId = binding.item?.value?.match(/\/(Q\d+)$/)?.[1];
    const website = webUrl(binding.website?.value);
    if (entityId && website && !websitesByEntity.has(entityId)) {
      websitesByEntity.set(entityId, website);
    }
  }
}

for (const attraction of missingWebsite) {
  const entityId = attraction.wikidata as string;
  const website = websitesByEntity.get(entityId);
  if (!website) continue;
  attraction.website = website;
  attraction.websiteSourceUrl = `https://www.wikidata.org/wiki/${entityId}`;
  attraction.contactUpdatedAt = updatedAt;
  wikidataWebsites += 1;
}

data.contactSources = [
  {
    name: "OpenStreetMap",
    url: "https://www.openstreetmap.org/copyright",
    license: "ODbL",
  },
  {
    name: "Wikidata",
    url: "https://www.wikidata.org/wiki/Wikidata:Licensing",
    license: "CC0",
  },
];
await writeFile(input, JSON.stringify(data));
console.log(
  `Enriched ${enriched} attractions from OSM; found ${osmWebsites} OSM and ${wikidataWebsites} Wikidata website candidates.`
);
