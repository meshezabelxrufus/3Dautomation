CREATE TABLE "drive_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"status" text DEFAULT 'RUNNING' NOT NULL,
	"mode" text NOT NULL,
	"error_reason" text,
	"summary" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "drive_exports_status" CHECK ("drive_exports"."status" in ('RUNNING', 'COMPLETED', 'FAILED')),
	CONSTRAINT "drive_exports_mode" CHECK ("drive_exports"."mode" in ('live', 'test'))
);
--> statement-breakpoint
CREATE TABLE "drive_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid,
	"item_key" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"drive_file_id" text,
	"drive_url" text,
	"source_asset_id" uuid,
	"uploaded_asset_id" uuid,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"error_reason" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"uploaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drive_items_kind" CHECK ("drive_items"."kind" in ('FOLDER', 'FILE')),
	CONSTRAINT "drive_items_status" CHECK ("drive_items"."status" in ('PENDING', 'DONE', 'FAILED')),
	CONSTRAINT "drive_items_done_has_id" CHECK ("drive_items"."status" <> 'DONE' or "drive_items"."drive_file_id" is not null)
);
--> statement-breakpoint
ALTER TABLE "drive_exports" ADD CONSTRAINT "drive_exports_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_items" ADD CONSTRAINT "drive_items_source_asset_id_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "drive_exports_one_running_per_project" ON "drive_exports" USING btree ("project_id") WHERE "drive_exports"."status" = 'RUNNING';--> statement-breakpoint
CREATE INDEX "drive_exports_project_idx" ON "drive_exports" USING btree ("project_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "drive_items_project_key" ON "drive_items" USING btree (coalesce("project_id", '00000000-0000-0000-0000-000000000000'::uuid),"item_key");--> statement-breakpoint
CREATE INDEX "drive_items_drive_file_idx" ON "drive_items" USING btree ("drive_file_id");