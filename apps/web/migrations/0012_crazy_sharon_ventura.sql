ALTER TABLE "app"."sessions" ADD COLUMN "impersonated_by" text;--> statement-breakpoint
ALTER TABLE "app"."two_factors" ADD COLUMN "verified" boolean DEFAULT true;--> statement-breakpoint
ALTER TABLE "app"."two_factors" ADD COLUMN "failed_verification_count" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "app"."two_factors" ADD COLUMN "locked_until" timestamp;