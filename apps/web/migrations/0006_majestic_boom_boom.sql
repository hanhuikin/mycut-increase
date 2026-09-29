CREATE TABLE "app"."provider_settings" (
	"provider" text PRIMARY KEY NOT NULL,
	"base_url" text DEFAULT '' NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."provider_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."ai_models" DROP COLUMN "route_base_urls";