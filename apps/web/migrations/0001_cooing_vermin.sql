CREATE TABLE "app"."provider_credentials" (
	"provider" text PRIMARY KEY NOT NULL,
	"api_key_enc" text NOT NULL,
	"api_key_suffix" text DEFAULT '' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."provider_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."ai_models" ADD COLUMN "modes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."ai_models" ADD COLUMN "supports_audio" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."ai_models" ADD COLUMN "max_duration" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."ai_models" ADD COLUMN "route_models" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."ai_models" ADD COLUMN "label_key" text;--> statement-breakpoint
ALTER TABLE "app"."ai_models" ADD COLUMN "description_key" text;