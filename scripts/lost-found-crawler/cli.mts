import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runAiReview } from "./ai-review.mjs";
import { extractRenderedForms } from "./browser.mjs";
import {
  crawlShardForOrigin,
  discoverChannels,
} from "./discovery.mjs";
import { extractFormsFromHtml } from "./form-extractor.mjs";
import {
  DEFAULT_GOOGLE_PLACE_TYPES,
  discoverGoogleSeededChannels,
  googleScanMinimumRequests,
} from "./google-places.mjs";
import {
  assertInventoryMatchesSource,
  buildInventory,
} from "./inventory.mjs";
import { mergeCandidateFiles } from "./merge.mjs";
import { auditLostFoundPipeline } from "./quality.mjs";
import { sanitizeReviewFile } from "./review-maintenance.mjs";
import {
  exportExtensionAdapters,
  publishReviewedChannels,
} from "./publish.mjs";
import {
  exportReviewReport,
  recordReviewDecision,
} from "./review.mjs";
import { refreshCandidateForms } from "./refresh.mjs";
import { buildResponsibilityGraph } from "./responsibility.mjs";
import { buildVenueEndpointScanReport } from "./scan-report.mjs";
import { safeFetchText } from "./safe-fetch.mjs";
import { verifyPublishedChannels } from "./verify.mjs";
import type { CandidateFile } from "./schemas";

const root = new URL("../../", import.meta.url);
const pathFromRoot = (path: string) => fileURLToPath(new URL(path, root));
const args = process.argv.slice(2);
const command = args[0];
const option = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return args.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};
const numberOption = (name: string, fallback: number): number => {
  const value = option(name);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative number`);
  }
  return parsed;
};
const assertCurrentInventory = () =>
  assertInventoryMatchesSource({
    inventoryPath: pathFromRoot("data/lost-found-crawler/inventory.json"),
    inputPath: pathFromRoot("public/berlin-attractions.json"),
  });

switch (command) {
  case "inventory": {
    const result = await buildInventory({
      inputPath: pathFromRoot("public/berlin-attractions.json"),
      outputPath: pathFromRoot("data/lost-found-crawler/inventory.json"),
      sourceLabel: "public/berlin-attractions.json",
      operatorOverridePath: pathFromRoot(
        "data/lost-found-crawler/operator-overrides.json"
      ),
    });
    console.log(JSON.stringify(result.summary, null, 2));
    break;
  }
  case "discover": {
    await assertCurrentInventory();
    const output = option("output");
    await discoverChannels({
      inventoryPath: pathFromRoot(
        option("inventory") ?? "data/lost-found-crawler/inventory.json"
      ),
      outputPath: pathFromRoot(
        output ?? "data/lost-found-crawler/channels.candidates.json"
      ),
      domain: option("domain"),
      domainLimit: numberOption("limit", Number.POSITIVE_INFINITY),
      maxPagesPerDomain: numberOption("max-pages", 60),
      maxDepth: numberOption("depth", 3),
      delayMs: numberOption("delay", 900),
      domainTimeoutMs: numberOption("domain-timeout-ms", 45_000),
      shardIndex: numberOption("shard-index", 0),
      shardCount: numberOption("shard-count", 1),
      renderDynamic: args.includes("--browser"),
      resume: args.includes("--resume"),
      checkpoint: !args.includes("--no-checkpoint"),
      onProgress: (message) => console.log(message),
    });
    const result = await mergeCandidateFiles({
      inputPaths: [
        pathFromRoot(
          output ?? "data/lost-found-crawler/channels.candidates.json"
        ),
      ],
      outputPath: pathFromRoot(
        output ?? "data/lost-found-crawler/channels.candidates.json"
      ),
    });
    console.log(
      `Discovered ${result.candidates.length} candidates; ${result.failures.length} seed failures.`
    );
    break;
  }
  case "scan-all": {
    const candidateOutput = pathFromRoot(
      option("output") ??
        "data/lost-found-crawler/channels.candidates.json"
    );
    await buildInventory({
      inputPath: pathFromRoot("public/berlin-attractions.json"),
      outputPath: pathFromRoot("data/lost-found-crawler/inventory.json"),
      sourceLabel: "public/berlin-attractions.json",
      operatorOverridePath: pathFromRoot(
        "data/lost-found-crawler/operator-overrides.json"
      ),
    });
    const usesExternalSharding = option("shard-count") !== undefined;
    const localConcurrency = usesExternalSharding
      ? 1
      : Math.max(1, Math.min(8, Math.floor(numberOption("concurrency", 6))));
    const externalShardCount = numberOption("shard-count", 1);
    const externalShardIndex = numberOption("shard-index", 0);
    const shardOutputs = Array.from(
      { length: localConcurrency },
      (_, index) =>
        localConcurrency === 1
          ? candidateOutput
          : `${candidateOutput}.shard-${index}.json`
    );
    const resumeInputs: string[] = [];
    if (!args.includes("--fresh") && localConcurrency > 1) {
      const resumeSourcePath = pathFromRoot(
        option("resume-from") ??
          "data/lost-found-crawler/channels.candidates.json"
      );
      try {
        const resumeSource = JSON.parse(
          await readFile(resumeSourcePath, "utf8")
        ) as CandidateFile;
        if (resumeSource.version === 1) {
          resumeInputs.push(resumeSourcePath);
          await Promise.all(
            shardOutputs.map(async (outputPath, workerIndex) => {
              try {
                await readFile(outputPath, "utf8");
                return;
              } catch {
                const checkpointSeed: CandidateFile = {
                  version: 1,
                  generatedAt: resumeSource.generatedAt,
                  candidates: [],
                  failures: [],
                  completedScopes: (resumeSource.completedScopes ?? []).filter(
                    (scope) =>
                      crawlShardForOrigin(scope.origin, localConcurrency) ===
                      workerIndex
                  ),
                };
                await writeFile(
                  outputPath,
                  `${JSON.stringify(checkpointSeed, null, 2)}\n`
                );
              }
            })
          );
        }
      } catch {
        // A missing or legacy resume source simply starts new shard files.
      }
    }
    await Promise.all(
      shardOutputs.map((outputPath, workerIndex) =>
        discoverChannels({
          inventoryPath: pathFromRoot(
            "data/lost-found-crawler/inventory.json"
          ),
          outputPath,
          domain: option("domain"),
          domainLimit: numberOption("limit", Number.POSITIVE_INFINITY),
          maxPagesPerDomain: numberOption("max-pages", 20),
          maxDepth: numberOption("depth", 2),
          delayMs: numberOption("delay", 900),
          shardIndex: usesExternalSharding
            ? externalShardIndex
            : workerIndex,
          shardCount: usesExternalSharding
            ? externalShardCount
            : localConcurrency,
          renderDynamic: args.includes("--browser"),
          resume: !args.includes("--fresh"),
          checkpoint: true,
          onProgress: (message) =>
            console.log(
              localConcurrency > 1
                ? `[crawl ${workerIndex + 1}/${localConcurrency}] ${message}`
                : message
            ),
        })
      )
    );
    const additionalInputs = (option("inputs") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map(pathFromRoot);
    let previousBase: string[] = [];
    if (!args.includes("--fresh") && localConcurrency > 1) {
      try {
        await readFile(candidateOutput, "utf8");
        previousBase = [candidateOutput];
      } catch {
        // The first concurrent scan has no earlier merged base.
      }
    }
    const candidatePaths = [
      ...new Set([
        ...resumeInputs,
        ...previousBase,
        ...shardOutputs,
        ...additionalInputs,
      ]),
    ];
    const candidates = await mergeCandidateFiles({
      inputPaths: candidatePaths,
      outputPath: candidateOutput,
    });
    const report = await buildVenueEndpointScanReport({
      inventoryPath: pathFromRoot("data/lost-found-crawler/inventory.json"),
      candidatePaths: [candidateOutput],
      registryPath: pathFromRoot("public/berlin-lost-found-channels.json"),
      reviewPath: pathFromRoot("data/lost-found-crawler/reviews.json"),
      outputPath: pathFromRoot(
        option("report") ??
          "data/lost-found-crawler/venue-endpoint-scan.json"
      ),
    });
    console.log(
      JSON.stringify(
        {
          crawlCandidates: candidates.candidates.length,
          ...report.summary,
        },
        null,
        2
      )
    );
    break;
  }
  case "scan-report": {
    await assertCurrentInventory();
    const inputPaths = (
      option("inputs") ??
      "data/lost-found-crawler/channels.candidates.json"
    )
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
      .map(pathFromRoot);
    const report = await buildVenueEndpointScanReport({
      inventoryPath: pathFromRoot("data/lost-found-crawler/inventory.json"),
      candidatePaths: inputPaths,
      registryPath: pathFromRoot("public/berlin-lost-found-channels.json"),
      reviewPath: pathFromRoot("data/lost-found-crawler/reviews.json"),
      outputPath: pathFromRoot(
        option("report") ??
          "data/lost-found-crawler/venue-endpoint-scan.json"
      ),
    });
    console.log(JSON.stringify(report.summary, null, 2));
    break;
  }
  case "google-discover": {
    const types = option("types")?.split(",").map((value) => value.trim()).filter(Boolean) ?? [
      ...DEFAULT_GOOGLE_PLACE_TYPES,
    ];
    const grid = numberOption("grid", 2);
    const minimumRequests = googleScanMinimumRequests({
      typeCount: types.length,
      grid,
    });
    if (args.includes("--dry-run")) {
      console.log(
        JSON.stringify(
          {
            types,
            grid,
            minimumGoogleApiRequests: minimumRequests,
            maximumGoogleApiRequests: numberOption("max-requests", 180),
            note: "Dense cells returning 20 places are subdivided, so the final request count can exceed the minimum.",
          },
          null,
          2
        )
      );
      break;
    }
    if (!args.includes("--confirm-billing")) {
      throw new Error(
        "google-discover uses a billable Google Places API. Inspect --dry-run first, then pass --confirm-billing."
      );
    }
    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      throw new Error(
        "Set GOOGLE_MAPS_API_KEY in the environment; do not put the key in a command-line argument."
      );
    }
    const result = await discoverGoogleSeededChannels({
      apiKey,
      attractionPath: pathFromRoot("public/berlin-attractions.json"),
      operatorOverridePath: pathFromRoot(
        "data/lost-found-crawler/operator-overrides.json"
      ),
      linkOutputPath: pathFromRoot(
        option("links-output") ??
          "data/lost-found-crawler/google-place-links.json"
      ),
      candidateOutputPath: pathFromRoot(
        option("output") ??
          "data/lost-found-crawler/google.channels.candidates.json"
      ),
      types,
      grid,
      maxDepth: numberOption("google-depth", 3),
      maxRequests: numberOption("max-requests", 180),
      googleDelayMs: numberOption("google-delay", 100),
      maxPagesPerDomain: numberOption("max-pages", 20),
      crawlDepth: numberOption("depth", 2),
      crawlDelayMs: numberOption("delay", 900),
      crawlShards: numberOption("crawl-shards", 4),
      renderDynamic: args.includes("--browser"),
      resume: args.includes("--resume"),
      checkpoint: !args.includes("--no-checkpoint"),
      onProgress: (message) => console.log(message),
    });
    console.log(
      `Google supplied ${result.links.summary.uniquePlaces} unique Place IDs and ${result.links.summary.officialWebsiteSeeds} website seeds; matched ${result.links.summary.matchedPlaces} to the open venue index, queued ${result.links.summary.pendingCanonicalization} website-backed places for canonicalization, and discovered ${result.candidates.candidates.length} official-channel candidates.`
    );
    if (result.links.summary.truncatedByRequestLimit) {
      console.warn(
        "The scan reached --max-requests and saved partial results. Raise the guard only after checking Google billing."
      );
    }
    break;
  }
  case "extract": {
    const file = option("file");
    const url = option("url");
    if (!file && !url) throw new Error("extract requires --file=... or --url=https://...");
    if (url && args.includes("--browser")) {
      console.log(
        JSON.stringify(
          await extractRenderedForms(url, {
            explore: args.includes("--explore"),
            maxStates: numberOption("max-states", 8),
          }),
          null,
          2
        )
      );
      break;
    }
    const pageUrl = url ?? "https://fixture.invalid/form";
    const html = file
      ? await readFile(file, "utf8")
      : (await safeFetchText(url as string)).body;
    console.log(JSON.stringify(extractFormsFromHtml({ html, pageUrl }), null, 2));
    break;
  }
  case "verify": {
    const report = await verifyPublishedChannels({
      registryPath: pathFromRoot("public/berlin-lost-found-channels.json"),
      outputPath: pathFromRoot("data/lost-found-crawler/verification-report.json"),
      statePath: pathFromRoot("data/lost-found-crawler/verification-state.json"),
      renderDynamic: args.includes("--browser"),
    });
    const changed = report.results.filter((result) => result.status !== "unchanged").length;
    console.log(`Verified ${report.results.length} channels; ${changed} need attention.`);
    if (changed > 0) process.exitCode = 1;
    break;
  }
  case "merge": {
    const inputs = option("inputs")?.split(",").filter(Boolean) ?? [];
    const merged = await mergeCandidateFiles({
      inputPaths: inputs,
      outputPath: pathFromRoot(
        option("output") ??
          "data/lost-found-crawler/channels.candidates.json"
      ),
    });
    console.log(
      `Merged ${merged.candidates.length} candidates; ${merged.failures.length} failures.`
    );
    break;
  }
  case "review-export": {
    await assertCurrentInventory();
    const count = await exportReviewReport({
      candidatePath: pathFromRoot("data/lost-found-crawler/channels.candidates.json"),
      reviewPath: pathFromRoot("data/lost-found-crawler/reviews.json"),
      inventoryPath: pathFromRoot("data/lost-found-crawler/inventory.json"),
      outputPath: pathFromRoot("data/lost-found-crawler/review-report.html"),
    });
    console.log(`Exported a review report for ${count} candidates.`);
    break;
  }
  case "review-sanitize": {
    const result = await sanitizeReviewFile({
      candidatePath: pathFromRoot(
        "data/lost-found-crawler/channels.candidates.json"
      ),
      reviewPath: pathFromRoot("data/lost-found-crawler/reviews.json"),
      quarantinePath: pathFromRoot(
        option("quarantine") ??
          "data/lost-found-crawler/reviews.quarantine.json"
      ),
      apply: args.includes("--apply"),
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.applied && result.quarantinedAcceptances > 0) {
      console.log("Dry run only; pass --apply to quarantine unsafe acceptances.");
    }
    break;
  }
  case "quality": {
    await assertCurrentInventory();
    const result = await auditLostFoundPipeline({
      inventoryPath: pathFromRoot("data/lost-found-crawler/inventory.json"),
      candidatePath: pathFromRoot(
        "data/lost-found-crawler/channels.candidates.json"
      ),
      reviewPath: pathFromRoot("data/lost-found-crawler/reviews.json"),
      registryPath: pathFromRoot("public/berlin-lost-found-channels.json"),
    });
    await writeFile(
      pathFromRoot(
        option("report") ??
          "data/lost-found-crawler/quality-report.json"
      ),
      `${JSON.stringify(result, null, 2)}\n`
    );
    console.log(JSON.stringify(result, null, 2));
    if (!result.health.ok) process.exitCode = 1;
    break;
  }
  case "coverage": {
    await assertCurrentInventory();
    const graph = await buildResponsibilityGraph({
      inventoryPath: pathFromRoot("data/lost-found-crawler/inventory.json"),
      registryPath: pathFromRoot("public/berlin-lost-found-channels.json"),
      outputPath: pathFromRoot(
        "data/lost-found-crawler/responsibilities.json"
      ),
      reportPath: pathFromRoot(
        "data/lost-found-crawler/coverage-report.json"
      ),
      runtimePath: pathFromRoot(
        "public/berlin-lost-found-responsibilities.json"
      ),
    });
    console.log(JSON.stringify(graph.summary, null, 2));
    break;
  }
  case "refresh": {
    const candidateIds = option("candidate")?.split(",").filter(Boolean) ?? [];
    if (!candidateIds.length) {
      throw new Error("refresh requires --candidate=id[,id]");
    }
    const refreshed = await refreshCandidateForms({
      candidatePath: pathFromRoot(
        "data/lost-found-crawler/channels.candidates.json"
      ),
      candidateIds,
      renderDynamic: args.includes("--browser"),
    });
    console.log(
      `Refreshed ${refreshed.length} candidate form snapshots without submitting them.`
    );
    break;
  }
  case "review": {
    const candidateId = option("candidate");
    const decision = option("decision");
    const reviewer = option("reviewer");
    if (!candidateId || !reviewer || (decision !== "accept" && decision !== "reject")) {
      throw new Error(
        "review requires --candidate=... --decision=accept|reject --reviewer=..."
      );
    }
    const recorded = await recordReviewDecision({
      candidatePath: pathFromRoot("data/lost-found-crawler/channels.candidates.json"),
      reviewPath: pathFromRoot("data/lost-found-crawler/reviews.json"),
      candidateId,
      decision,
      reviewedBy: reviewer,
      notes: option("notes"),
      kindOverride: option("kind"),
      venueIdsOverride: option("venues")?.split(",").filter(Boolean),
      submissionMode: option("submission-mode"),
      adapterId: option("adapter"),
    });
    console.log(`Recorded ${recorded.decision} for ${recorded.candidateId}.`);
    break;
  }
  case "ai-review": {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ai-review requires DEEPSEEK_API_KEY in the process environment"
      );
    }
    const report = await runAiReview({
      candidatePath: pathFromRoot(
        "data/lost-found-crawler/channels.candidates.json"
      ),
      reviewPath: pathFromRoot("data/lost-found-crawler/reviews.json"),
      reportPath: pathFromRoot(
        option("report") ??
          "data/lost-found-crawler/ai-review-report.json"
      ),
      apiKey,
      model:
        option("model") ??
        process.env.DEEPSEEK_MODEL ??
        "deepseek-v4-flash",
      baseUrl: process.env.DEEPSEEK_BASE_URL,
      candidateIds: option("candidate")?.split(",").filter(Boolean),
      limit: numberOption("limit", 25),
      apply: args.includes("--apply"),
      overwrite: args.includes("--overwrite"),
      acceptThreshold: numberOption("accept-threshold", 0.9),
      rejectThreshold: numberOption("reject-threshold", 0.95),
      timeoutMs: numberOption("timeout-ms", 60_000),
      concurrency: numberOption("concurrency", 4),
      modelBatchSize: numberOption("batch-size", 8),
    });
    console.log(JSON.stringify(report.summary, null, 2));
    console.log(
      report.applied
        ? `Applied ${report.summary.recommended} acceptance(s) and ` +
          `${report.summary.rejected} rejection(s) to reviews.json; ` +
          `${report.summary.needsReview} candidate(s) failed a deterministic check ` +
          `and stay in the queue.`
        : "Dry run only; pass --apply to write the decisions."
    );
    break;
  }
  case "publish": {
    await assertCurrentInventory();
    const responsibilityPath = pathFromRoot(
      "data/lost-found-crawler/responsibilities.json"
    );
    await buildResponsibilityGraph({
      inventoryPath: pathFromRoot("data/lost-found-crawler/inventory.json"),
      registryPath: pathFromRoot("public/berlin-lost-found-channels.json"),
      outputPath: responsibilityPath,
      reportPath: pathFromRoot(
        "data/lost-found-crawler/coverage-report.json"
      ),
      runtimePath: pathFromRoot(
        "public/berlin-lost-found-responsibilities.json"
      ),
    });
    const registry = await publishReviewedChannels({
      candidatePath: pathFromRoot("data/lost-found-crawler/channels.candidates.json"),
      reviewPath: pathFromRoot("data/lost-found-crawler/reviews.json"),
      adapterPath: pathFromRoot("data/lost-found-crawler/adapters.json"),
      responsibilityPath,
      outputPath: pathFromRoot("public/berlin-lost-found-channels.json"),
      allowCoverageRegression: args.includes("--allow-coverage-regression"),
    });
    await buildResponsibilityGraph({
      inventoryPath: pathFromRoot("data/lost-found-crawler/inventory.json"),
      registryPath: pathFromRoot("public/berlin-lost-found-channels.json"),
      outputPath: responsibilityPath,
      reportPath: pathFromRoot(
        "data/lost-found-crawler/coverage-report.json"
      ),
      runtimePath: pathFromRoot(
        "public/berlin-lost-found-responsibilities.json"
      ),
    });
    const adapterCount = await exportExtensionAdapters({
      adapterPath: pathFromRoot("data/lost-found-crawler/adapters.json"),
      registryPath: pathFromRoot("public/berlin-lost-found-channels.json"),
      outputPath: pathFromRoot("extension/adapters.js"),
    });
    console.log(
      `Published ${registry.channels.length} reviewed channels and ${adapterCount} tested form adapters (fill-only and reviewed-submit combined).`
    );
    break;
  }
  default:
    throw new Error(
      "Usage: cli.mts <inventory|discover|scan-all|scan-report|google-discover|extract|merge|refresh|review|ai-review|review-export|review-sanitize|quality|coverage|verify|publish> [--option=value]"
    );
}
