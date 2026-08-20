import type { CandidateFile } from "../lost-found-crawler/schemas";
import { crawlShardForOrigin } from "../lost-found-crawler/discovery.mjs";

type Environment = Record<string, string | undefined>;

export type CloudRunTaskConfig = {
  bucket: string;
  runId: string;
  taskIndex: number;
  taskCount: number;
  domainLimit?: number;
  maxPages: number;
  maxDepth: number;
  delayMs: number;
  domainTimeoutMs: number;
};

function integerEnvironment(
  environment: Environment,
  name: string,
  fallback: number,
  minimum = 0
): number {
  const raw = environment[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }
  return value;
}

export function cloudRunTaskConfig(
  environment: Environment = process.env
): CloudRunTaskConfig {
  const bucket = environment.CRAWL_BUCKET?.trim();
  if (!bucket) throw new Error("CRAWL_BUCKET is required");
  const taskCount = integerEnvironment(
    environment,
    "CLOUD_RUN_TASK_COUNT",
    integerEnvironment(environment, "CRAWL_SHARD_COUNT", 1, 1),
    1
  );
  const taskIndex = integerEnvironment(
    environment,
    "CLOUD_RUN_TASK_INDEX",
    0
  );
  if (taskIndex >= taskCount) {
    throw new Error("CLOUD_RUN_TASK_INDEX must be smaller than CLOUD_RUN_TASK_COUNT");
  }
  const domainLimit = environment.DOMAIN_LIMIT
    ? integerEnvironment(environment, "DOMAIN_LIMIT", 1, 1)
    : undefined;
  return {
    bucket,
    runId:
      environment.CRAWL_RUN_ID?.trim() ||
      environment.CLOUD_RUN_EXECUTION?.trim() ||
      new Date().toISOString().replace(/[:.]/g, "-"),
    taskIndex,
    taskCount,
    domainLimit,
    maxPages: integerEnvironment(environment, "MAX_PAGES", 20, 1),
    maxDepth: integerEnvironment(environment, "MAX_DEPTH", 2, 0),
    delayMs: integerEnvironment(environment, "CRAWL_DELAY_MS", 900, 0),
    domainTimeoutMs: integerEnvironment(
      environment,
      "DOMAIN_TIMEOUT_MS",
      45_000,
      1_000
    ),
  };
}

export function resumableShardSeed(
  baseline: CandidateFile,
  taskIndex: number,
  taskCount: number
): CandidateFile {
  return {
    version: 1,
    generatedAt: baseline.generatedAt,
    candidates: [],
    failures: [],
    completedScopes: (baseline.completedScopes ?? []).filter(
      (checkpoint) =>
        crawlShardForOrigin(checkpoint.origin, taskCount) === taskIndex
    ),
  };
}

export function runObjectPrefix(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-|-$/g, "");
  if (!safe) throw new Error("CRAWL_RUN_ID must contain a safe filename character");
  return `lost-found-runs/${safe}`;
}
