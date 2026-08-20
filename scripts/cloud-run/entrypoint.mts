import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Storage } from "@google-cloud/storage";
import { buildVenueEndpointScanReport } from "../lost-found-crawler/scan-report.mjs";
import { discoverChannels } from "../lost-found-crawler/discovery.mjs";
import { mergeCandidateFiles } from "../lost-found-crawler/merge.mjs";
import { auditLostFoundPipeline } from "../lost-found-crawler/quality.mjs";
import type { CandidateFile } from "../lost-found-crawler/schemas";
import {
  cloudRunTaskConfig,
  resumableShardSeed,
  runObjectPrefix,
} from "./runtime.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
const projectPath = (value: string) => join(root, value);
const baselinePath = projectPath(
  "data/lost-found-crawler/channels.candidates.json"
);
const inventoryPath = projectPath("data/lost-found-crawler/inventory.json");
const registryPath = projectPath("public/berlin-lost-found-channels.json");
const reviewPath = projectPath("data/lost-found-crawler/reviews.json");
const storage = new Storage();

async function upload(
  bucketName: string,
  sourcePath: string,
  destination: string,
  metadata: Record<string, string> = {}
) {
  await storage.bucket(bucketName).upload(sourcePath, {
    destination,
    resumable: false,
    metadata: {
      cacheControl: "no-store",
      metadata,
    },
  });
}

async function runShard() {
  const config = cloudRunTaskConfig();
  const prefix = runObjectPrefix(config.runId);
  const workingDirectory = "/tmp/lost-found-crawl";
  await mkdir(workingDirectory, { recursive: true });
  const outputPath = join(
    workingDirectory,
    `shard-${config.taskIndex}-of-${config.taskCount}.json`
  );
  const baseline = JSON.parse(
    await readFile(baselinePath, "utf8")
  ) as CandidateFile;
  await writeFile(
    outputPath,
    `${JSON.stringify(
      resumableShardSeed(baseline, config.taskIndex, config.taskCount),
      null,
      2
    )}\n`
  );
  console.log(
    JSON.stringify({
      event: "crawl_task_started",
      runId: config.runId,
      taskIndex: config.taskIndex,
      taskCount: config.taskCount,
      domainLimit: config.domainLimit ?? null,
      maxPages: config.maxPages,
      delayMs: config.delayMs,
      domainTimeoutMs: config.domainTimeoutMs,
    })
  );
  const result = await discoverChannels({
    inventoryPath,
    outputPath,
    domainLimit: config.domainLimit,
    maxPagesPerDomain: config.maxPages,
    maxDepth: config.maxDepth,
    delayMs: config.delayMs,
    domainTimeoutMs: config.domainTimeoutMs,
    shardIndex: config.taskIndex,
    shardCount: config.taskCount,
    renderDynamic: false,
    resume: true,
    checkpoint: true,
    onProgress: (message) =>
      console.log(`[task ${config.taskIndex + 1}/${config.taskCount}] ${message}`),
  });
  const destination = `${prefix}/shards/${config.taskIndex}.json`;
  await upload(config.bucket, outputPath, destination, {
    runId: config.runId,
    taskIndex: String(config.taskIndex),
    taskCount: String(config.taskCount),
  });
  console.log(
    JSON.stringify({
      event: "crawl_task_completed",
      runId: config.runId,
      taskIndex: config.taskIndex,
      candidates: result.candidates.length,
      failures: result.failures.length,
      completedScopes: result.completedScopes?.length ?? 0,
      object: `gs://${config.bucket}/${destination}`,
    })
  );
}

async function runMerge() {
  const config = cloudRunTaskConfig();
  const prefix = runObjectPrefix(config.runId);
  const workingDirectory = "/tmp/lost-found-merge";
  await mkdir(workingDirectory, { recursive: true });
  const [objects] = await storage.bucket(config.bucket).getFiles({
    prefix: `${prefix}/shards/`,
  });
  const shardObjects = objects
    .filter((object) => /\/\d+\.json$/.test(object.name))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (!shardObjects.length) {
    throw new Error(`No shard objects found below gs://${config.bucket}/${prefix}`);
  }
  const shardPaths: string[] = [];
  for (const object of shardObjects) {
    const destination = join(workingDirectory, object.name.split("/").at(-1)!);
    await object.download({ destination });
    shardPaths.push(destination);
  }
  const mergedPath = join(workingDirectory, "channels.candidates.json");
  const scanReportPath = join(workingDirectory, "venue-endpoint-scan.json");
  const qualityReportPath = join(workingDirectory, "quality-report.json");
  const merged = await mergeCandidateFiles({
    inputPaths: [baselinePath, ...shardPaths],
    outputPath: mergedPath,
  });
  const scan = await buildVenueEndpointScanReport({
    inventoryPath,
    candidatePaths: [mergedPath],
    registryPath,
    reviewPath,
    outputPath: scanReportPath,
  });
  const quality = await auditLostFoundPipeline({
    inventoryPath,
    candidatePath: mergedPath,
    reviewPath,
    registryPath,
  });
  await writeFile(qualityReportPath, `${JSON.stringify(quality, null, 2)}\n`);
  const manifestPath = join(workingDirectory, "manifest.json");
  const manifest = {
    version: 1,
    runId: config.runId,
    generatedAt: new Date().toISOString(),
    shardObjects: shardObjects.length,
    candidates: merged.candidates.length,
    failures: merged.failures.length,
    completedScopes: merged.completedScopes?.length ?? 0,
    scan: scan.summary,
    health: quality.health,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await Promise.all([
    upload(config.bucket, mergedPath, `${prefix}/merged/channels.candidates.json`),
    upload(config.bucket, scanReportPath, `${prefix}/merged/venue-endpoint-scan.json`),
    upload(config.bucket, qualityReportPath, `${prefix}/merged/quality-report.json`),
    upload(config.bucket, manifestPath, `${prefix}/manifest.json`),
  ]);
  console.log(JSON.stringify({ event: "crawl_merge_completed", ...manifest }));
  if (!quality.health.ok) process.exitCode = 1;
}

const mode = process.env.CRAWL_MODE?.trim() || "shard";
if (mode === "shard") {
  await runShard();
} else if (mode === "merge") {
  await runMerge();
} else {
  throw new Error("CRAWL_MODE must be shard or merge");
}
