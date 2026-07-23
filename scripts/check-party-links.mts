import { PARTIES, type PartySourceField } from "../app/lost-found/parties";

const PUBLIC_FIELDS: PartySourceField[] = [
  "scope",
  "website",
  "formUrl",
  "email",
  "phone",
  "address",
  "hours",
  "retention",
  "nextStep",
  "note",
];

const errors: string[] = [];
const urls = new Set<string>();

for (const party of Object.values(PARTIES)) {
  if (!party.lastVerifiedAt.match(/^20\d{2}-\d{2}-\d{2}$/)) {
    errors.push(`${party.id}: missing or invalid lastVerifiedAt`);
  }
  for (const field of PUBLIC_FIELDS) {
    if (party[field] && !party.fieldSources[field]) {
      errors.push(`${party.id}.${field}: missing official source URL`);
    }
  }
  for (const url of [
    party.website,
    party.formUrl,
    ...Object.values(party.fieldSources),
    ...(party.relatedLinks ?? []).map((link) => link.url),
  ]) {
    if (url) urls.add(url);
  }
}

async function probe(url: string): Promise<string | null> {
  const request = async (method: "HEAD" | "GET") => {
    const response = await fetch(url, {
      method,
      redirect: "follow",
      headers:
        method === "GET"
          ? { Range: "bytes=0-0", "User-Agent": "Berlin-Lost-Found-Link-Check/1.0" }
          : { "User-Agent": "Berlin-Lost-Found-Link-Check/1.0" },
      signal: AbortSignal.timeout(20_000),
    });
    return response.status;
  };

  try {
    let status = await request("HEAD");
    if (status === 405 || status === 501) status = await request("GET");
    // Authentication, bot protection and rate limiting still prove the endpoint
    // is live; 404/410 and server failures indicate a broken user destination.
    if (status === 404 || status === 410 || status >= 500) {
      return `${url} returned HTTP ${status}`;
    }
    return null;
  } catch (error) {
    return `${url} could not be reached: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

const queue = [...urls];
const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
  while (queue.length) {
    const url = queue.shift();
    if (!url) return;
    const failure = await probe(url);
    if (failure) errors.push(failure);
    else console.log(`ok ${url}`);
  }
});
await Promise.all(workers);

if (errors.length) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${urls.size} unique official links.`);
}
