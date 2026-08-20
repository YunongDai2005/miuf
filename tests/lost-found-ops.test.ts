import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PublishedChannelRegistry } from "../lib/lost-found-channel-schema";
import {
  buildOpsDashboardSnapshot,
  type CoverageSnapshot,
  type PipelineQualitySnapshot,
} from "../lib/lost-found-ops";
import type {
  CandidateFile,
  InventoryFile,
  ReviewFile,
} from "../scripts/lost-found-crawler/schemas";

async function json<T>(relativePath: string): Promise<T> {
  return JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), "utf8")
  ) as T;
}

test("operations snapshot reconciles current crawl, review and publication metrics", async () => {
  const [inventory, candidates, reviews, registry, quality, coverage, quarantine] =
    await Promise.all([
      json<InventoryFile>("../data/lost-found-crawler/inventory.json"),
      json<CandidateFile>(
        "../data/lost-found-crawler/channels.candidates.json"
      ),
      json<ReviewFile>("../data/lost-found-crawler/reviews.json"),
      json<PublishedChannelRegistry>(
        "../public/berlin-lost-found-channels.json"
      ),
      json<PipelineQualitySnapshot>(
        "../data/lost-found-crawler/quality-report.json"
      ),
      json<CoverageSnapshot>(
        "../data/lost-found-crawler/coverage-report.json"
      ),
      json<{ entries: Array<{ reason: string }> }>(
        "../data/lost-found-crawler/reviews.quarantine.json"
      ),
    ]);
  const snapshot = buildOpsDashboardSnapshot({
    inventory,
    candidates,
    reviews,
    registry,
    quality,
    coverage,
    quarantine,
  });

  assert.equal(snapshot.headline.totalVenues, inventory.venues.length);
  assert.equal(
    snapshot.headline.crawlCompleted,
    quality.discovery.currentCompletedScopes
  );
  assert.equal(snapshot.headline.crawlTotal, quality.discovery.currentScopeGroups);
  assert.equal(
    snapshot.headline.currentAcceptances,
    quality.review.publishableAcceptances
  );
  assert.equal(snapshot.headline.publishedChannels, registry.channels.length);
  assert.equal(
    snapshot.headline.coveredVenues,
    new Set(registry.channels.flatMap((channel) => channel.venueIds)).size
  );
  assert.equal(
    snapshot.headline.officialSourceFallbackVenues,
    coverage.summary.officialContact
  );
  assert.ok(snapshot.headline.directContactFallbackCandidateVenues > 0);
  assert.ok(
    snapshot.headline.directContactFallbackCandidateVenues <=
      snapshot.headline.officialSourceFallbackVenues
  );
  assert.equal(
    snapshot.candidateMix.reduce((sum, entry) => sum + entry.value, 0),
    snapshot.headline.candidates
  );
  assert.equal(
    snapshot.reviewMix.reduce((sum, entry) => sum + entry.value, 0),
    snapshot.headline.candidates
  );
  assert.ok(snapshot.issues.some((issue) => issue.id === "candidate-evidence"));
  assert.ok(snapshot.batchTargets.length >= 5);
  assert.ok(snapshot.batchTargets.every((target) => target.candidates >= 3));
});
