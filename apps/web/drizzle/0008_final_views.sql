ALTER TABLE "final_designs" ADD COLUMN "master_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "final_designs" ADD COLUMN "view_prompts" jsonb;--> statement-breakpoint
ALTER TABLE "final_views" ADD COLUMN "image_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "final_views" ADD COLUMN "generation_prompt" text;--> statement-breakpoint
ALTER TABLE "final_views" ADD COLUMN "error_reason" text;--> statement-breakpoint
ALTER TABLE "final_views" ADD COLUMN "image_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "final_designs" ADD CONSTRAINT "final_designs_master_asset_id_assets_id_fk" FOREIGN KEY ("master_asset_id") REFERENCES "public"."assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "final_views" ADD CONSTRAINT "final_views_image_asset_id_assets_id_fk" FOREIGN KEY ("image_asset_id") REFERENCES "public"."assets"("id") ON DELETE set null ON UPDATE no action;