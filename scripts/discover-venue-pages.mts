import { mkdir, readFile, writeFile } from "node:fs/promises";

type Attraction = {
  id: string;
  name: string;
  website?: string;
  operatorWebsite?: string;
  lostFoundUrl?: string;
};

const input = new URL("../public/berlin-attractions.json", import.meta.url);
const output = new URL("../data/venue-responsibility-candidates.json", import.meta.url);
const payload = JSON.parse(await readFile(input, "utf8")) as {
  attractions: Attraction[];
};
const limitArg = process.argv.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : Infinity;
const applyHighConfidence = process.argv.includes("--apply-high-confidence");

const LOST_TERMS = [
  "lost property",
  "lost and found",
  "lost-found",
  "fundbüro",
  "fundbuero",
  "fundsache",
  "verlust",
];
const CONTACT_TERMS = ["contact", "kontakt", "visitor service", "besucherservice", "service"];

function stripMarkup(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&nbsp;", " ")
    .replace(/\s+/g, " ")
    .trim();
}

function linksFrom(html: string, base: URL) {
  const links: Array<{ url: string; label: string; score: number }> = [];
  const pattern = /<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(pattern)) {
    try {
      const url = new URL(match[1], base);
      if (url.hostname !== base.hostname || !["http:", "https:"].includes(url.protocol)) continue;
      const label = stripMarkup(match[2]);
      const searchable = `${url.pathname} ${label}`.toLowerCase();
      const lostHits = LOST_TERMS.filter((term) => searchable.includes(term)).length;
      const contactHits = CONTACT_TERMS.filter((term) => searchable.includes(term)).length;
      const score = lostHits * 100 + contactHits * 10;
      if (score) links.push({ url: url.toString(), label: label || url.pathname, score });
    } catch {
      // Ignore malformed page links.
    }
  }
  return [...new Map(links.map((link) => [link.url, link])).values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

const domains = new Map<string, { website: string; venues: Attraction[] }>();
for (const attraction of payload.attractions) {
  const website = attraction.website ?? attraction.operatorWebsite;
  if (!website) continue;
  try {
    const hostname = new URL(website).hostname;
    const existing = domains.get(hostname);
    if (existing) existing.venues.push(attraction);
    else domains.set(hostname, { website, venues: [attraction] });
  } catch {
    // The enrichment script already filters URLs; keep this defensive for hand edits.
  }
}

type DiscoveryResult = {
  venueIds: string[];
  venueNames: string[];
  officialWebsite: string;
  candidates: Array<{ url: string; label: string; score: number }>;
};
const results: DiscoveryResult[] = [];
const groups = [...domains.values()].slice(0, limit);
let nextGroup = 0;

async function discoverNext(): Promise<void> {
  const groupIndex = nextGroup;
  nextGroup += 1;
  const group = groups[groupIndex];
  if (!group) return;
  try {
    const response = await fetch(group.website, {
      redirect: "follow",
      headers: { "user-agent": "Berlin-Lost-and-Found-contact-discovery/1.0" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) {
      const html = await response.text();
      const base = new URL(response.url);
      results.push({
        venueIds: group.venues.map((venue) => venue.id),
        venueNames: group.venues.map((venue) => venue.name),
        officialWebsite: base.toString(),
        candidates: linksFrom(html, base),
      });
    }
  } catch {
    // Discovery is best-effort. A failed domain remains available as an official homepage.
  }
  await discoverNext();
}

await Promise.all(
  Array.from({ length: Math.min(6, groups.length) }, () => discoverNext())
);
results.sort((a, b) => a.venueNames[0].localeCompare(b.venueNames[0]));

let applied = 0;
if (applyHighConfidence) {
  const highConfidenceByVenue = new Map<string, string>();
  for (const result of results) {
    const candidate = result.candidates.find((entry) => entry.score >= 100);
    if (!candidate) continue;
    for (const id of result.venueIds) highConfidenceByVenue.set(id, candidate.url);
  }
  for (const attraction of payload.attractions) {
    const lostFoundUrl = highConfidenceByVenue.get(attraction.id);
    if (!lostFoundUrl) continue;
    attraction.lostFoundUrl = lostFoundUrl;
    applied += 1;
  }
  await writeFile(input, JSON.stringify(payload));
}

await mkdir(new URL("../data/", import.meta.url), { recursive: true });
await writeFile(
  output,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      note:
        "Review candidates against the official site before promoting any URL to lostFoundUrl.",
      venues: results,
    },
    null,
    2
  )
);
console.log(
  `Wrote contact candidates for ${results.length} official venue domains; applied ${applied} high-confidence lost-property links.`
);
