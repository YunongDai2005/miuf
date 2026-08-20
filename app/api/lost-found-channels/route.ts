import candidateData from "../../../data/lost-found-crawler/channels.candidates.json";
import adapterData from "../../../data/lost-found-crawler/adapters.json";
import reviewData from "../../../data/lost-found-crawler/reviews.json";
import bundledChannelData from "../../../public/berlin-lost-found-channels.json";
import { readCurrentReviewDecisions } from "../../../db/channel-reviews";
import {
  buildPublishedChannelRegistry,
  mergePublishedChannelRegistries,
} from "../../../lib/lost-found-channel-publish";
import type { PublishedChannelRegistry } from "../../../lib/lost-found-channel-schema";
import type {
  AdapterFile,
  CandidateFile,
  ReviewFile,
} from "../../../scripts/lost-found-crawler/schemas";

export const dynamic = "force-dynamic";

export async function GET() {
  const candidates = candidateData as unknown as CandidateFile;
  const adapters = adapterData as unknown as AdapterFile;
  try {
    const decisions = await readCurrentReviewDecisions(
      candidates.candidates,
      (reviewData as unknown as ReviewFile).decisions
    );
    const bundled = bundledChannelData as unknown as PublishedChannelRegistry;
    const reviewed = buildPublishedChannelRegistry({
      candidates,
      reviews: { version: 1, decisions },
      adapters,
      generatedAt: decisions.reduce(
        (latest, decision) =>
          decision.reviewedAt > latest ? decision.reviewedAt : latest,
        bundled.generatedAt
      ),
    });
    const registry = mergePublishedChannelRegistries(bundled, reviewed);
    return Response.json(registry, {
      headers: {
        "Cache-Control": "public, max-age=60, stale-if-error=300",
      },
    });
  } catch {
    return Response.json(
      { error: "The reviewed channel registry is temporarily unavailable." },
      {
        status: 503,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}
