CREATE TABLE `channel_review_current` (
	`candidate_id` text PRIMARY KEY NOT NULL,
	`candidate_version` text NOT NULL,
	`action` text NOT NULL,
	`decision_json` text,
	`reviewer_email` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
