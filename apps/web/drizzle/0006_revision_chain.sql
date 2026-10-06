ALTER TABLE "concepts" ADD COLUMN "active_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN "base_revision_id" uuid;