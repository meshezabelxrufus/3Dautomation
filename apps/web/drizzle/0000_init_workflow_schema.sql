CREATE TYPE "public"."concept_status" AS ENUM('GENERATING', 'READY', 'SELECTED', 'REJECTED', 'REFINING', 'FINAL', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."final_design_status" AS ENUM('PENDING', 'FINALIZED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."project_event_type" AS ENUM('PROJECT_CREATED', 'CONCEPT_GENERATION_STARTED', 'CONCEPT_GENERATION_COMPLETED', 'CONCEPT_SELECTED', 'CONCEPT_REJECTED', 'REFINEMENT_STARTED', 'REVISION_CREATED', 'DESIGN_FINALIZED', 'VIEW_GENERATION_STARTED', 'VIEW_GENERATED', 'VIEW_APPROVED', 'DRIVE_UPLOAD_STARTED', 'DRIVE_UPLOAD_COMPLETED', 'PROJECT_COMPLETED', 'GENERATION_FAILED');--> statement-breakpoint
CREATE TYPE "public"."project_status" AS ENUM('DRAFT', 'GENERATING_CONCEPTS', 'CONCEPT_REVIEW', 'REFINING', 'FINALIZING', 'GENERATING_VIEWS', 'VIEW_REVIEW', 'UPLOADING_TO_DRIVE', 'COMPLETED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."revision_status" AS ENUM('GENERATING', 'READY', 'SELECTED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."view_status" AS ENUM('GENERATING', 'READY', 'APPROVED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."view_type" AS ENUM('FRONT', 'BACK', 'LEFT', 'RIGHT');--> statement-breakpoint
CREATE TYPE "public"."workflow_entity" AS ENUM('project', 'concept', 'revision', 'final_design', 'final_view');--> statement-breakpoint
CREATE TABLE "concepts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"concept_number" integer NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"creative_direction" text,
	"key_features" text[] DEFAULT '{}'::text[] NOT NULL,
	"materials" text[] DEFAULT '{}'::text[] NOT NULL,
	"generation_prompt" text,
	"image_url" text,
	"status" "concept_status" DEFAULT 'GENERATING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "concepts_project_concept_number_key" UNIQUE("project_id","concept_number"),
	CONSTRAINT "concepts_id_project_key" UNIQUE("id","project_id"),
	CONSTRAINT "concepts_concept_number_positive" CHECK ("concepts"."concept_number" >= 1),
	CONSTRAINT "concepts_image_required" CHECK ("concepts"."status" in ('GENERATING', 'FAILED') or "concepts"."image_url" is not null)
);
--> statement-breakpoint
CREATE TABLE "final_designs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"approved_concept_id" uuid NOT NULL,
	"approved_revision_id" uuid,
	"master_image" text NOT NULL,
	"status" "final_design_status" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "final_designs_id_project_key" UNIQUE("id","project_id"),
	CONSTRAINT "final_designs_finalized_at_consistent" CHECK (("final_designs"."status" = 'FINALIZED') = ("final_designs"."finalized_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "final_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"final_design_id" uuid NOT NULL,
	"view_type" "view_type" NOT NULL,
	"version_number" integer DEFAULT 1 NOT NULL,
	"is_current" boolean DEFAULT true NOT NULL,
	"image_url" text,
	"drive_file_id" text,
	"status" "view_status" DEFAULT 'GENERATING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "final_views_project_type_version_key" UNIQUE("project_id","view_type","version_number"),
	CONSTRAINT "final_views_version_positive" CHECK ("final_views"."version_number" >= 1),
	CONSTRAINT "final_views_image_required" CHECK ("final_views"."status" in ('GENERATING', 'FAILED') or "final_views"."image_url" is not null)
);
--> statement-breakpoint
CREATE TABLE "project_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "project_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"project_id" uuid NOT NULL,
	"event_type" "project_event_type" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_events_payload_object" CHECK (jsonb_typeof("project_events"."payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_name" text NOT NULL,
	"client_name" text NOT NULL,
	"design_brief" text NOT NULL,
	"status" "project_status" DEFAULT 'DRAFT' NOT NULL,
	"failed_from_status" "project_status",
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "projects_project_name_len" CHECK (char_length("projects"."project_name") between 1 and 200),
	CONSTRAINT "projects_client_name_len" CHECK (char_length("projects"."client_name") between 1 and 200),
	CONSTRAINT "projects_design_brief_len" CHECK (char_length("projects"."design_brief") between 1 and 4000),
	CONSTRAINT "projects_failed_from_status_consistent" CHECK (("projects"."status" = 'FAILED') = ("projects"."failed_from_status" is not null)),
	CONSTRAINT "projects_finalized_at_consistent" CHECK (("projects"."status" = 'COMPLETED') = ("projects"."finalized_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"concept_id" uuid NOT NULL,
	"revision_number" integer NOT NULL,
	"client_feedback" text NOT NULL,
	"interpreted_instruction" jsonb,
	"generation_prompt" text,
	"image_url" text,
	"status" "revision_status" DEFAULT 'GENERATING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "revisions_concept_revision_number_key" UNIQUE("concept_id","revision_number"),
	CONSTRAINT "revisions_id_concept_key" UNIQUE("id","concept_id"),
	CONSTRAINT "revisions_revision_number_positive" CHECK ("revisions"."revision_number" >= 1),
	CONSTRAINT "revisions_client_feedback_len" CHECK (char_length("revisions"."client_feedback") between 1 and 1000),
	CONSTRAINT "revisions_image_required" CHECK ("revisions"."status" in ('GENERATING', 'FAILED') or "revisions"."image_url" is not null),
	CONSTRAINT "revisions_interpreted_instruction_object" CHECK ("revisions"."interpreted_instruction" is null or jsonb_typeof("revisions"."interpreted_instruction") = 'object')
);
--> statement-breakpoint
CREATE TABLE "workflow_status_transitions" (
	"entity" "workflow_entity" NOT NULL,
	"from_status" text NOT NULL,
	"to_status" text NOT NULL,
	CONSTRAINT "workflow_status_transitions_entity_from_status_to_status_pk" PRIMARY KEY("entity","from_status","to_status")
);
--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "final_designs" ADD CONSTRAINT "final_designs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "final_designs" ADD CONSTRAINT "final_designs_concept_same_project_fk" FOREIGN KEY ("approved_concept_id","project_id") REFERENCES "public"."concepts"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "final_designs" ADD CONSTRAINT "final_designs_revision_same_concept_fk" FOREIGN KEY ("approved_revision_id","approved_concept_id") REFERENCES "public"."revisions"("id","concept_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "final_views" ADD CONSTRAINT "final_views_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "final_views" ADD CONSTRAINT "final_views_design_same_project_fk" FOREIGN KEY ("final_design_id","project_id") REFERENCES "public"."final_designs"("id","project_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revisions" ADD CONSTRAINT "revisions_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "concepts_project_status_idx" ON "concepts" USING btree ("project_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "final_designs_one_active_per_project" ON "final_designs" USING btree ("project_id") WHERE "final_designs"."status" <> 'CANCELLED';--> statement-breakpoint
CREATE INDEX "final_designs_approved_concept_idx" ON "final_designs" USING btree ("approved_concept_id");--> statement-breakpoint
CREATE INDEX "final_designs_approved_revision_idx" ON "final_designs" USING btree ("approved_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "final_views_one_current_per_type" ON "final_views" USING btree ("project_id","view_type") WHERE "final_views"."is_current";--> statement-breakpoint
CREATE INDEX "final_views_project_status_idx" ON "final_views" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "final_views_final_design_idx" ON "final_views" USING btree ("final_design_id");--> statement-breakpoint
CREATE INDEX "project_events_project_created_idx" ON "project_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "project_events_type_created_idx" ON "project_events" USING btree ("event_type","created_at");--> statement-breakpoint
CREATE INDEX "projects_status_updated_at_idx" ON "projects" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "projects_created_at_idx" ON "projects" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "projects_client_name_idx" ON "projects" USING btree ("client_name");--> statement-breakpoint
CREATE UNIQUE INDEX "revisions_one_generating_per_concept" ON "revisions" USING btree ("concept_id") WHERE "revisions"."status" = 'GENERATING';--> statement-breakpoint
CREATE UNIQUE INDEX "revisions_one_selected_per_concept" ON "revisions" USING btree ("concept_id") WHERE "revisions"."status" = 'SELECTED';