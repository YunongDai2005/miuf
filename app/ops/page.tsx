import type { Metadata } from "next";
import { requireChatGPTUser } from "../chatgpt-auth";
import candidateData from "../../data/lost-found-crawler/channels.candidates.json";
import coverageData from "../../data/lost-found-crawler/coverage-report.json";
import inventoryData from "../../data/lost-found-crawler/inventory.json";
import qualityData from "../../data/lost-found-crawler/quality-report.json";
import quarantineData from "../../data/lost-found-crawler/reviews.quarantine.json";
import reviewData from "../../data/lost-found-crawler/reviews.json";
import registryData from "../../public/berlin-lost-found-channels.json";
import type { PublishedChannelRegistry } from "../../lib/lost-found-channel-schema";
import {
  buildOpsDashboardSnapshot,
  type CoverageSnapshot,
  type PipelineQualitySnapshot,
} from "../../lib/lost-found-ops";
import type {
  CandidateFile,
  InventoryFile,
  ReviewFile,
} from "../../scripts/lost-found-crawler/schemas";
import OpsDashboard, { type RemoteFeedStatus } from "./OpsDashboard";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Pipeline operations | Berlin Lost & Found",
  description: "Private operations dashboard for lost-property channel data.",
};

const REMOTE_MANIFEST_URL =
  "https://yulid.org/berlin-lost-found/v1/manifest.json";

async function remoteFeedStatus(
  localGeneratedAt: string
): Promise<RemoteFeedStatus> {
  try {
    const response = await fetch(REMOTE_MANIFEST_URL, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = (await response.json()) as {
      generatedAt?: string;
      publishedAt?: string;
      datasetVersion?: string;
      summary?: { channels?: number; reviewedVenues?: number };
    };
    if (
      typeof manifest.generatedAt !== "string" ||
      !Number.isFinite(Date.parse(manifest.generatedAt))
    ) {
      throw new Error("invalid manifest");
    }
    const current = manifest.generatedAt >= localGeneratedAt;
    return {
      state: current ? "current" : "behind",
      generatedAt: manifest.generatedAt,
      publishedAt: manifest.publishedAt,
      datasetVersion: manifest.datasetVersion,
      channels: manifest.summary?.channels,
      reviewedVenues: manifest.summary?.reviewedVenues,
      message: current
        ? "The public feed matches or exceeds the local registry."
        : "The local registry is newer; deployment is still pending.",
    };
  } catch (error) {
    return {
      state: "unavailable",
      message:
        error instanceof Error
          ? `The public feed could not be checked: ${error.message}`
          : "The public feed could not be checked.",
    };
  }
}

export default async function OpsPage() {
  // The production dashboard remains private behind ChatGPT auth. A local
  // development server has no auth proxy, so expose the read-only dashboard
  // with an explicit local identity for operational testing.
  const user =
    process.env.NODE_ENV === "development"
      ? {
          displayName: "Local operator",
          email: "local-operator@localhost",
          fullName: "Local operator",
        }
      : await requireChatGPTUser("/ops");
  const snapshot = buildOpsDashboardSnapshot({
    inventory: inventoryData as unknown as InventoryFile,
    candidates: candidateData as unknown as CandidateFile,
    reviews: reviewData as unknown as ReviewFile,
    registry: registryData as unknown as PublishedChannelRegistry,
    quality: qualityData as unknown as PipelineQualitySnapshot,
    coverage: coverageData as unknown as CoverageSnapshot,
    quarantine: quarantineData,
  });
  const remote = await remoteFeedStatus(
    (registryData as unknown as PublishedChannelRegistry).generatedAt
  );
  return (
    <OpsDashboard
      snapshot={snapshot}
      remote={remote}
      operatorName={user.displayName}
    />
  );
}
