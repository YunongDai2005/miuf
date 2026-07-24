import type { Metadata } from "next";
import { requireChatGPTUser } from "../chatgpt-auth";
import candidateData from "../../data/lost-found-crawler/channels.candidates.json";
import inventoryData from "../../data/lost-found-crawler/inventory.json";
import reviewData from "../../data/lost-found-crawler/reviews.json";
import type {
  CandidateFile,
  InventoryFile,
  ReviewFile,
} from "../../scripts/lost-found-crawler/schemas";
import ReviewWorkbench from "./ReviewWorkbench";

export const metadata: Metadata = {
  title: "Channel review | Berlin Lost & Found",
  description: "Private review workspace for official lost-property channels.",
};

export default async function ReviewPage() {
  const user = await requireChatGPTUser("/review");
  const candidates = candidateData as unknown as CandidateFile;
  const inventory = inventoryData as unknown as InventoryFile;
  const reviews = reviewData as unknown as ReviewFile;
  const venueNames = Object.fromEntries(
    inventory.venues
      .filter((venue) =>
        candidates.candidates.some((candidate) =>
          candidate.venueIds.includes(venue.venueId)
        )
      )
      .map((venue) => [venue.venueId, venue.venueName])
  );
  const operatorNames = Object.fromEntries(
    inventory.operators.map((operator) => [operator.id, operator.name])
  );

  return (
    <ReviewWorkbench
      generatedAt={candidates.generatedAt}
      candidates={candidates.candidates}
      initialDecisions={reviews.decisions}
      reviewerName={user.displayName}
      venueNames={venueNames}
      operatorNames={operatorNames}
    />
  );
}
