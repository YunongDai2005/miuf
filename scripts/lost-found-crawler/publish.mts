import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CHANNEL_REGISTRY_VERSION,
  isPublishedLostFoundChannel,
  type PublishedChannelRegistry,
  type PublishedLostFoundChannel,
} from "../../lib/lost-found-channel-schema";
import type {
  AdapterFile,
  CandidateFile,
  ReviewFile,
} from "./schemas";

const FORM_KINDS = new Set([
  "dedicated_lost_found_form",
  "operator_lost_found_form",
  "general_contact_form",
]);

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
  const candidatesById = new Map(
    candidates.candidates.map((candidate) => [candidate.id, candidate])
  );
  const channels: PublishedLostFoundChannel[] = [];
  const acceptedIds = new Set<string>();

  for (const decision of reviews.decisions) {
    if (decision.decision !== "accept") continue;
    if (acceptedIds.has(decision.candidateId)) {
      throw new Error(`Duplicate accepted review for ${decision.candidateId}`);
    }
    const candidate = candidatesById.get(decision.candidateId);
    if (!candidate) {
      throw new Error(`Accepted review references missing candidate ${decision.candidateId}`);
    }
    const kind = decision.kindOverride ?? candidate.kind;
    if (kind === "manual_review") {
      throw new Error(
        `Accepted candidate ${candidate.id} needs an explicit kindOverride`
      );
    }
    const reviewedTimestamp = Date.parse(decision.reviewedAt);
    if (
      !decision.reviewedBy.trim() ||
      !decision.reviewedAt.match(/^20\d{2}-\d{2}-\d{2}/) ||
      !Number.isFinite(reviewedTimestamp)
    ) {
      throw new Error(`Accepted candidate ${candidate.id} has incomplete reviewer metadata`);
    }
    const venueIds = decision.venueIdsOverride ?? candidate.venueIds;
    if (
      venueIds.length === 0 ||
      venueIds.some((venueId) => !venueId.trim())
    ) {
      throw new Error(`Accepted candidate ${candidate.id} has no valid venue assignment`);
    }
    const form = candidate.form;
    if (FORM_KINDS.has(kind) && (!form || form.fields.length === 0)) {
      throw new Error(
        `Candidate ${candidate.id} cannot publish a form kind without an extracted form`
      );
    }
    if (
      kind === "email" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate.contactValue ?? "")
    ) {
      throw new Error(`Candidate ${candidate.id} has no valid reviewed email value`);
    }
    if (
      kind === "phone" &&
      (candidate.contactValue ?? "").replace(/\D/g, "").length < 6
    ) {
      throw new Error(`Candidate ${candidate.id} has no valid reviewed phone value`);
    }
    // Human acceptance confirms the destination, not every field selector.
    // Assisted filling therefore remains an explicit second decision.
    const defaultSubmissionMode = "open_only";
    if (
      (decision.submissionMode === "assisted_fill" ||
        decision.submissionMode === "adapter") &&
      (!form || form.fields.length === 0)
    ) {
      throw new Error(
        `Candidate ${candidate.id} cannot enable assisted filling without extracted form fields`
      );
    }
    if (
      (decision.submissionMode === "assisted_fill" ||
        decision.submissionMode === "adapter") &&
      decision.reviewedContentHash !== form?.contentHash
    ) {
      throw new Error(
        `Candidate ${candidate.id} form changed after its field review`
      );
    }
    const adapter = decision.adapterId
      ? adapterFile.adapters.find((entry) => entry.id === decision.adapterId)
      : undefined;
    if (decision.submissionMode === "adapter") {
      if (
        !adapter ||
        adapter.channelId !== candidate.id ||
        adapter.testedContentHash !== candidate.form?.contentHash ||
        new URL(candidate.pageUrl).origin !== adapter.origin
      ) {
        throw new Error(
          `Candidate ${candidate.id} cannot publish adapter mode without a matching tested adapter`
        );
      }
      if (
        !adapter.submitSelector.trim() ||
        (!adapter.successSelector?.trim() && !adapter.successText?.trim())
      ) {
        throw new Error(
          `Candidate ${candidate.id} adapter needs a submit selector and a reviewed success state`
        );
      }
      try {
        new RegExp(adapter.pathPattern);
      } catch {
        throw new Error(
          `Candidate ${candidate.id} adapter has an invalid path pattern`
        );
      }
    }
    const publishedChannel: PublishedLostFoundChannel = {
      id: candidate.id,
      operatorId: candidate.operatorId,
      venueIds: [...new Set(venueIds)].sort(),
      kind,
      scope: candidate.operatorId ? "operator" : "venue",
      pageUrl: candidate.pageUrl,
      contactValue: candidate.contactValue,
      formAction: form?.formAction,
      formMethod: form?.formMethod,
      language: form?.language ?? ["und"],
      fields: form?.fields.filter((field) => field.control !== "hidden") ?? [],
      captcha: form?.captcha ?? false,
      loginRequired: form?.loginRequired ?? false,
      submissionMode: decision.submissionMode ?? defaultSubmissionMode,
      adapterId:
        decision.submissionMode === "adapter" ? decision.adapterId : undefined,
      verifiedAt: decision.reviewedAt,
      reviewDueAt: new Date(
        reviewedTimestamp + 90 * 24 * 60 * 60 * 1000
      ).toISOString(),
      verifiedBy: decision.reviewedBy,
      evidence: candidate.evidence,
      contentHash:
        form?.contentHash ?? candidate.evidence[0]?.contentHash ?? "",
    };
    if (!isPublishedLostFoundChannel(publishedChannel)) {
      throw new Error(
        `Candidate ${candidate.id} produced an invalid public channel`
      );
    }
    channels.push(publishedChannel);
    acceptedIds.add(decision.candidateId);
  }

  channels.sort((left, right) => left.id.localeCompare(right.id));
  const registry: PublishedChannelRegistry = {
    version: CHANNEL_REGISTRY_VERSION,
    generatedAt: new Date().toISOString(),
    channels,
  };
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
