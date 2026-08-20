import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  fetchRemoteLostFoundData,
  isRemoteDataManifest,
  readCachedLostFoundData,
} from "../app/lost-found/remoteData";

const manifestUrl = "https://updates.example/berlin/v1/manifest.json";

async function fixture() {
  const channelText = await readFile(
    new URL("../public/berlin-lost-found-channels.json", import.meta.url),
    "utf8"
  );
  const responsibilityText = await readFile(
    new URL("../public/berlin-lost-found-responsibilities.json", import.meta.url),
    "utf8"
  );
  const channels = JSON.parse(channelText) as { generatedAt: string };
  const responsibilities = JSON.parse(responsibilityText) as {
    generatedAt: string;
  };
  const generatedAt =
    channels.generatedAt > responsibilities.generatedAt
      ? channels.generatedAt
      : responsibilities.generatedAt;
  const manifest = {
    version: 1 as const,
    datasetVersion: "0123456789abcdef",
    generatedAt,
    publishedAt: "2026-07-26T20:00:00.000Z",
    resources: {
      channels: {
        path: "channels.json",
        sha256: createHash("sha256").update(channelText).digest("hex"),
        bytes: Buffer.byteLength(channelText),
      },
      responsibilities: {
        path: "responsibilities.json",
        sha256: createHash("sha256").update(responsibilityText).digest("hex"),
        bytes: Buffer.byteLength(responsibilityText),
      },
    },
  };
  return { manifest, channelText, responsibilityText };
}

test("downloads only same-origin manifest resources and verifies their hashes", async () => {
  const { manifest, channelText, responsibilityText } = await fixture();
  const responses = new Map<string, string>([
    [manifestUrl, JSON.stringify(manifest)],
    ["https://updates.example/berlin/v1/channels.json", channelText],
    [
      "https://updates.example/berlin/v1/responsibilities.json",
      responsibilityText,
    ],
  ]);
  const fetcher = (async (input: string | URL | Request) => {
    const body = responses.get(String(input));
    return body === undefined
      ? new Response("missing", { status: 404 })
      : new Response(body, { status: 200 });
  }) as typeof fetch;
  const result = await fetchRemoteLostFoundData({
    manifestUrl,
    fetcher,
    now: new Date("2026-07-26T20:01:00.000Z"),
  });
  assert.equal(isRemoteDataManifest(manifest), true);
  assert.equal(result.source, "remote");
  assert.equal(
    result.channels.channels.length,
    (JSON.parse(channelText) as { channels: unknown[] }).channels.length
  );
  assert.equal(result.responsibilities.assignments.length, 4850);
  assert.equal(result.checkedAt, "2026-07-26T20:01:00.000Z");
});

test("rejects a changed resource and accepts only an intact verified cache", async () => {
  const { manifest, channelText, responsibilityText } = await fixture();
  const tamperedFetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === manifestUrl) return new Response(JSON.stringify(manifest));
    if (url.endsWith("channels.json")) {
      return new Response(channelText.replace('"version": 1', '"version": 2'));
    }
    return new Response(responsibilityText);
  }) as typeof fetch;
  await assert.rejects(
    fetchRemoteLostFoundData({ manifestUrl, fetcher: tamperedFetcher }),
    /size does not match|integrity check/
  );

  const cached = await readCachedLostFoundData({
    manifestUrl,
    now: new Date("2026-07-26T20:02:00.000Z"),
    storage: {
      getItem() {
        return JSON.stringify({
          version: 1,
          sourceUrl: manifestUrl,
          storedAt: "2026-07-26T20:01:00.000Z",
          manifest,
          channelText,
          responsibilityText,
        });
      },
    },
  });
  assert.equal(cached?.source, "cache");
  assert.match(cached?.warning ?? "", /last verified download/);

  const stale = await readCachedLostFoundData({
    manifestUrl,
    now: new Date("2026-08-03T20:01:00.001Z"),
    storage: {
      getItem() {
        return JSON.stringify({
          version: 1,
          sourceUrl: manifestUrl,
          storedAt: "2026-07-26T20:01:00.000Z",
          manifest,
          channelText,
          responsibilityText,
        });
      },
    },
  });
  assert.equal(stale, null);
});
