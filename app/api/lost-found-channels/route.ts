import candidateData from "../../../data/lost-found-crawler/channels.candidates.json";
import adapterData from "../../../data/lost-found-crawler/adapters.json";
import reviewData from "../../../data/lost-found-crawler/reviews.json";
import { readCurrentReviewDecisions } from "../../../db/channel-reviews";
import { buildPublishedChannelRegistry } from "../../../lib/lost-found-channel-publish";
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
    const registry = buildPublishedChannelRegistry({
      candidates,
      reviews: { version: 1, decisions },
      adapters,
      generatedAt: decisions.reduce(
        (latest, decision) =>
          decision.reviewedAt > latest ? decision.reviewedAt : latest,
        candidates.generatedAt
      ),
    });
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
