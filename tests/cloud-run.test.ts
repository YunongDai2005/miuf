import assert from "node:assert/strict";
import { test } from "node:test";
import candidateData from "../data/lost-found-crawler/channels.candidates.json" with {
  type: "json",
};
import type { CandidateFile } from "../scripts/lost-found-crawler/schemas";
import {
  cloudRunTaskConfig,
  resumableShardSeed,
  runObjectPrefix,
} from "../scripts/cloud-run/runtime.mjs";

test("Cloud Run task configuration validates task bounds", () => {
  const config = cloudRunTaskConfig({
    CRAWL_BUCKET: "lf-crawl-test",
    CRAWL_RUN_ID: "smoke-2026-07-28",
    CLOUD_RUN_TASK_INDEX: "2",
    CLOUD_RUN_TASK_COUNT: "3",
    DOMAIN_LIMIT: "1",
    MAX_PAGES: "8",
    MAX_DEPTH: "2",
    CRAWL_DELAY_MS: "900",
    DOMAIN_TIMEOUT_MS: "45000",
  });
  assert.equal(config.taskIndex, 2);
  assert.equal(config.taskCount, 3);
  assert.equal(config.domainLimit, 1);
  assert.equal(config.domainTimeoutMs, 45_000);
  assert.equal(runObjectPrefix(config.runId), "lost-found-runs/smoke-2026-07-28");
});

test("Cloud Run tasks share the execution name when no run id is supplied", () => {
  const config = cloudRunTaskConfig({
    CRAWL_BUCKET: "lf-crawl-test",
    CLOUD_RUN_EXECUTION: "lost-found-crawl-abc12",
    CLOUD_RUN_TASK_INDEX: "0",
    CLOUD_RUN_TASK_COUNT: "8",
  });
  assert.equal(config.runId, "lost-found-crawl-abc12");
});

test("Cloud Run shard seed carries only matching resumable checkpoints", () => {
  const baseline = candidateData as unknown as CandidateFile;
  const seeds = Array.from({ length: 4 }, (_, taskIndex) =>
    resumableShardSeed(baseline, taskIndex, 4)
  );
  assert.equal(
    seeds.reduce(
      (total, seed) => total + (seed.completedScopes?.length ?? 0),
      0
    ),
    baseline.completedScopes?.length ?? 0
  );
  assert.ok(seeds.every((seed) => seed.candidates.length === 0));
  assert.ok(seeds.every((seed) => seed.failures.length === 0));
});
