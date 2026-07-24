import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { extractRenderedForms } from "./browser.mjs";
import { discoverChannels } from "./discovery.mjs";
import { extractFormsFromHtml } from "./form-extractor.mjs";
import { buildInventory } from "./inventory.mjs";
import { mergeCandidateFiles } from "./merge.mjs";
import {
  exportExtensionAdapters,
  publishReviewedChannels,
} from "./publish.mjs";
import {
  exportReviewReport,
  recordReviewDecision,
} from "./review.mjs";
import { safeFetchText } from "./safe-fetch.mjs";
import { verifyPublishedChannels } from "./verify.mjs";

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

switch (command) {
  case "inventory": {
    const result = await buildInventory({
      inputPath: pathFromRoot("public/berlin-attractions.json"),
      outputPath: pathFromRoot("data/lost-found-crawler/inventory.json"),
      sourceLabel: "public/berlin-attractions.json",
    });
    console.log(JSON.stringify(result.summary, null, 2));
    break;
  }
  case "discover": {
    const output = option("output");
    const result = await discoverChannels({
      inventoryPath: pathFromRoot("data/lost-found-crawler/inventory.json"),
      outputPath: pathFromRoot(
        output ?? "data/lost-found-crawler/channels.candidates.json"
      ),
      domain: option("domain"),
      domainLimit: numberOption("limit", Number.POSITIVE_INFINITY),
      maxPagesPerDomain: numberOption("max-pages", 60),
      maxDepth: numberOption("depth", 3),
      delayMs: numberOption("delay", 900),
      shardIndex: numberOption("shard-index", 0),
      shardCount: numberOption("shard-count", 1),
      renderDynamic: args.includes("--browser"),
    });
    console.log(
      `Discovered ${result.candidates.length} candidates; ${result.failures.length} seed failures.`
    );
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
      outputPath: pathFromRoot("data/lost-found-crawler/channels.candidates.json"),
    });
    console.log(
      `Merged ${merged.candidates.length} candidates; ${merged.failures.length} failures.`
    );
    break;
  }
  case "review-export": {
    const count = await exportReviewReport({
      candidatePath: pathFromRoot("data/lost-found-crawler/channels.candidates.json"),
      reviewPath: pathFromRoot("data/lost-found-crawler/reviews.json"),
      inventoryPath: pathFromRoot("data/lost-found-crawler/inventory.json"),
      outputPath: pathFromRoot("data/lost-found-crawler/review-report.html"),
    });
    console.log(`Exported a review report for ${count} candidates.`);
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
  case "publish": {
    const registry = await publishReviewedChannels({
      candidatePath: pathFromRoot("data/lost-found-crawler/channels.candidates.json"),
      reviewPath: pathFromRoot("data/lost-found-crawler/reviews.json"),
      adapterPath: pathFromRoot("data/lost-found-crawler/adapters.json"),
      outputPath: pathFromRoot("public/berlin-lost-found-channels.json"),
    });
    const adapterCount = await exportExtensionAdapters({
      adapterPath: pathFromRoot("data/lost-found-crawler/adapters.json"),
      registryPath: pathFromRoot("public/berlin-lost-found-channels.json"),
      outputPath: pathFromRoot("extension/adapters.js"),
    });
    console.log(
      `Published ${registry.channels.length} reviewed channels and ${adapterCount} tested adapters.`
    );
    break;
  }
  default:
    throw new Error(
      "Usage: cli.mts <inventory|discover|extract|merge|review|review-export|verify|publish> [--option=value]"
    );
}
