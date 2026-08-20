/**
 * Runs the two-stage resolver over every venue that could hold an office of its
 * own, and reports what share of them publish a reachable lost-property page.
 *
 *   node --import tsx scripts/lost-found-crawler/resolve-all.mts [--limit=N] [--concurrency=N]
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolveLostAndFound, type PlaceResolution } from "./resolve-place.mjs";

const OUTPUT = "data/lost-found-crawler/place-resolutions.json";

const option = (name: string, fallback: number): number => {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  const value = raw ? Number(raw.split("=")[1]) : NaN;
  return Number.isFinite(value) ? value : fallback;
};

// The place index carries the websites now, so the inventory is only consulted
// when it is the more current source for a venue already resolved there.
const attractions = JSON.parse(
  await readFile("public/berlin-attractions.json", "utf8")
) as { attractions: Array<{ id: string; name: string; category: string; website?: string; phone?: string }> };

const only = process.argv.find((arg) => arg.startsWith("--categories="))?.split("=")[1];
const wanted = only ? new Set(only.split(",")) : undefined;

// One resolution per website: sixteen SMB museums share one site and one office.
const bySite = new Map<
  string,
  { website: string; names: string[]; venueIds: string[]; phone?: string }
>();
for (const place of attractions.attractions) {
  if (!place.website) continue;
  if (wanted && !wanted.has(place.category)) continue;
  let origin: string;
  try {
    origin = new URL(place.website).origin;
  } catch {
    continue;
  }
  const entry = bySite.get(origin) ?? { website: origin, names: [], venueIds: [] };
  entry.names.push(place.name);
  entry.venueIds.push(place.id);
  entry.phone ??= place.phone;
  bySite.set(origin, entry);
}

const targets = [...bySite.values()].slice(0, option("limit", Number.POSITIVE_INFINITY));
const concurrency = option("concurrency", 6);
console.log(
  `${attractions.attractions.length} places -> ${bySite.size} distinct websites; ` +
    `resolving ${targets.length} with concurrency ${concurrency}\n`
);

const results: Array<PlaceResolution & { names: string[]; venueIds: string[] }> = [];
let done = 0;
const queue = [...targets];

await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const target = queue.shift();
      if (!target) break;
      try {
        const resolution = await resolveLostAndFound({
          website: target.website,
          placeName: target.names[0],
          phone: target.phone,
          maxPages: 25,
        });
        results.push({ ...resolution, names: target.names, venueIds: target.venueIds });
        if (resolution.status === "PAGE_FOUND") {
          console.log(
            `  ✓ ${target.names[0].slice(0, 34).padEnd(36)} ${resolution.lostFoundUrl?.slice(0, 60)}`
          );
        }
      } catch {
        results.push({
          website: target.website,
          placeName: target.names[0],
          status: "MANUAL_REVIEW",
          pagesRead: 0,
          checkedAt: new Date().toISOString(),
          names: target.names,
          venueIds: target.venueIds,
        });
      }
      done += 1;
      if (done % 25 === 0) console.log(`  … ${done}/${targets.length}`);
    }
  })
);

const found = results.filter((r) => r.status === "PAGE_FOUND");
const venuesCovered = new Set(found.flatMap((r) => r.venueIds));
const byStage = found.reduce<Record<string, number>>((acc, r) => {
  const key = r.discoveredVia ?? "?";
  acc[key] = (acc[key] ?? 0) + 1;
  return acc;
}, {});

console.log(`\n${"=".repeat(64)}`);
console.log(`websites resolved        ${results.length}`);
console.log(`  PAGE_FOUND             ${found.length}  (${((found.length / results.length) * 100).toFixed(1)}%)`);
console.log(`  PHONE_FALLBACK         ${results.filter((r) => r.status === "PHONE_FALLBACK").length}`);
console.log(`  MANUAL_REVIEW          ${results.filter((r) => r.status === "MANUAL_REVIEW").length}`);
console.log(`venues behind those      ${venuesCovered.size}`);
console.log(`found via                ${JSON.stringify(byStage)}`);
console.log(
  `pages read, median        ${
    [...results.map((r) => r.pagesRead)].sort((a, b) => a - b)[Math.floor(results.length / 2)]
  }`
);
console.log(
  `with a contact on the page ${found.filter((r) => r.contactValues?.length).length}`
);

await writeFile(
  OUTPUT,
  `${JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), results }, null, 2)}\n`
);
console.log(`\nwritten to ${OUTPUT}`);
