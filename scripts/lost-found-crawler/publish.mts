import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CHANNEL_REGISTRY_VERSION,
  isPublishedChannelRegistry,
  type PublishedChannelRegistry,
} from "../../lib/lost-found-channel-schema";
import {
  buildPublishedChannelRegistry,
  mergePublishedChannelRegistries,
} from "../../lib/lost-found-channel-publish";
import type {
  AdapterFile,
  CandidateFile,
  ResponsibilityGraph,
  ReviewFile,
} from "./schemas";

export async function publishReviewedChannels(options: {
  candidatePath: string;
  reviewPath: string;
  adapterPath: string;
  responsibilityPath?: string;
  outputPath: string;
  allowCoverageRegression?: boolean;
}): Promise<PublishedChannelRegistry> {
  const candidates = JSON.parse(
    await readFile(options.candidatePath, "utf8")
  ) as CandidateFile;
  const reviews = JSON.parse(
    await readFile(options.reviewPath, "utf8")
  ) as ReviewFile;
  const adapterFile = JSON.parse(
    await readFile(options.adapterPath, "utf8")
  ) as AdapterFile;
  const responsibilities = options.responsibilityPath
    ? (JSON.parse(
        await readFile(options.responsibilityPath, "utf8")
      ) as ResponsibilityGraph)
    : undefined;
  if (
    candidates.version !== 1 ||
    reviews.version !== 1 ||
    adapterFile.version !== 1
  ) {
    throw new Error("Unsupported candidate or review file version");
  }
  let registry = buildPublishedChannelRegistry({
    candidates,
    reviews,
    adapters: adapterFile,
    responsibilities,
  });
  if (!options.allowCoverageRegression) {
    try {
      const current = JSON.parse(
        await readFile(options.outputPath, "utf8")
      ) as unknown;
      if (isPublishedChannelRegistry(current)) {
        registry = mergePublishedChannelRegistries(current, registry);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        // A first publication has no previous coverage to protect.
      } else {
        throw error;
      }
    }
  }
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, `${JSON.stringify(registry, null, 2)}\n`);
  return registry;
}

export async function exportExtensionAdapters(options: {
  adapterPath: string;
  registryPath: string;
  outputPath: string;
}): Promise<number> {
  const adapterFile = JSON.parse(
    await readFile(options.adapterPath, "utf8")
  ) as AdapterFile;
  const registry = JSON.parse(
    await readFile(options.registryPath, "utf8")
  ) as PublishedChannelRegistry;
  if (adapterFile.version !== 1 || !Array.isArray(adapterFile.adapters)) {
    throw new Error("Unsupported adapter file version");
  }
  if (
    registry.version !== CHANNEL_REGISTRY_VERSION ||
    !Array.isArray(registry.channels)
  ) {
    throw new Error("Unsupported published channel registry version");
  }
  const approvedAdapters = registry.channels
    .filter((channel) => Boolean(channel.adapterId))
    .map((channel) => {
      const adapter = adapterFile.adapters.find(
        (entry) => entry.id === channel.adapterId
      );
      if (
        !adapter ||
        adapter.channelId !== channel.id ||
        adapter.testedContentHash !== channel.contentHash ||
        adapter.origin !== new URL(channel.pageUrl).origin ||
        (channel.submissionMode === "adapter" &&
          adapter.capability !== "reviewed_submit")
      ) {
        throw new Error(
          `Published adapter channel ${channel.id} has no exact approved form adapter`
        );
      }
      return adapter;
    });
  const source = `globalThis.BERLIN_LOST_FOUND_ADAPTERS = Object.freeze(${JSON.stringify(
    approvedAdapters,
    null,
    2
  )});\n`;
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, source);
  return approvedAdapters.length;
}
