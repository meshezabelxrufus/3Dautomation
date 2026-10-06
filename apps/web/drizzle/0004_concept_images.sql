CREATE TYPE "public"."asset_kind" AS ENUM('CONCEPT', 'REVISION', 'VIEW', 'REFERENCE');--> statement-breakpoint
ALTER TYPE "public"."project_event_type" ADD VALUE 'CONCEPT_IMAGE_GENERATED';--> statement-breakpoint
ALTER TYPE "public"."project_event_type" ADD VALUE 'CONCEPT_IMAGE_FAILED';--> statement-breakpoint
ALTER TYPE "public"."project_event_type" ADD VALUE 'CONCEPT_RESTORED';--> statement-breakpoint
CREATE TABLE "assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"kind" "asset_kind" NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"width" integer,
	"height" integer,
	"sha256" text NOT NULL,
	"provider" text,
	"model" text,
	"provider_request_id" text,
	"provider_url" text,
	"prompt" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "assets_bytes_positive" CHECK ("assets"."bytes" > 0),
	CONSTRAINT "assets_mime_image" CHECK ("assets"."mime_type" in ('image/png', 'image/jpeg', 'image/webp'))
);
--> statement-breakpoint
ALTER TABLE "concepts" ADD COLUMN "image_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "concepts" ADD COLUMN "image_error" text;--> statement-breakpoint
ALTER TABLE "concepts" ADD COLUMN "image_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN "image_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "revisions" ADD COLUMN "error_reason" text;--> statement-breakpoint
ALTER TABLE "assets" ADD CONSTRAINT "assets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "assets_project_idx" ON "assets" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "assets_sha256_idx" ON "assets" USING btree ("sha256");--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_image_asset_id_assets_id_fk" FOREIGN KEY ("image_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_image_asset_id_assets_id_fk" FOREIGN KEY ("image_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;