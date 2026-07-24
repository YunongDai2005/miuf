CREATE TABLE `channel_review_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`candidate_id` text NOT NULL,
	`candidate_version` text NOT NULL,
	`action` text NOT NULL,
	`decision_json` text,
	`reviewer_email` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `channel_review_events_candidate_idx` ON `channel_review_events` (`candidate_id`,`id`);