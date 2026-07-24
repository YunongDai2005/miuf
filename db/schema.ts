import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Immutable audit log for private channel-review actions. The latest event for
 * a candidate is its current state; a `clear` event removes it from the current
 * review set without deleting history.
 */
export const channelReviewEvents = sqliteTable(
  "channel_review_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    candidateId: text("candidate_id").notNull(),
    candidateVersion: text("candidate_version").notNull(),
    action: text("action", {
      enum: ["accept", "reject", "clear"],
    }).notNull(),
    decisionJson: text("decision_json"),
    reviewerEmail: text("reviewer_email").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("channel_review_events_candidate_idx").on(
      table.candidateId,
      table.id
    ),
  ]
);

/**
 * Materialized latest state keeps the public registry read bounded while the
 * append-only event table preserves the full audit trail.
 */
export const channelReviewCurrent = sqliteTable("channel_review_current", {
  candidateId: text("candidate_id").primaryKey(),
  candidateVersion: text("candidate_version").notNull(),
  action: text("action", {
    enum: ["accept", "reject", "clear"],
  }).notNull(),
  decisionJson: text("decision_json"),
  reviewerEmail: text("reviewer_email").notNull(),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});
