ALTER TABLE "concepts" DROP CONSTRAINT "concepts_image_required";--> statement-breakpoint
ALTER TABLE "concepts" ADD COLUMN "visual_characteristics" text;--> statement-breakpoint
ALTER TABLE "concepts" ADD COLUMN "shape_language" text;--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_final_requires_image" CHECK ("concepts"."status" <> 'FINAL' or "concepts"."image_url" is not null);