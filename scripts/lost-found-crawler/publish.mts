import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CHANNEL_REGISTRY_VERSION,
  type PublishedChannelRegistry,
} from "../../lib/lost-found-channel-schema";
import { buildPublishedChannelRegistry } from "../../lib/lost-found-channel-publish";
import type {
  AdapterFile,
  CandidateFile,
  ReviewFile,
} from "./schemas";

export async function publishReviewedChannels(options: {
  candidatePath: string;
  reviewPath: string;
  adapterPath: string;
  outputPath: string;
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
  if (
    candidates.version !== 1 ||
    reviews.version !== 1 ||
    adapterFile.version !== 1
  ) {
    throw new Error("Unsupported candidate or review file version");
  }
  const registry = buildPublishedChannelRegistry({
    candidates,
    reviews,
    adapters: adapterFile,
  });
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
    .filter((channel) => channel.submissionMode === "adapter")
    .map((channel) => {
      const adapter = adapterFile.adapters.find(
        (entry) => entry.id === channel.adapterId
      );
      if (
        !adapter ||
        adapter.channelId !== channel.id ||
        adapter.testedContentHash !== channel.contentHash ||
        adapter.origin !== new URL(channel.pageUrl).origin
      ) {
        throw new Error(
          `Published adapter channel ${channel.id} has no exact approved adapter`
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
