CREATE TABLE "app"."channels" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"protocol" text NOT NULL,
	"base_url" text DEFAULT '' NOT NULL,
	"api_key_enc" text DEFAULT '' NOT NULL,
	"api_key_suffix" text DEFAULT '' NOT NULL,
	"models" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text DEFAULT '' NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."channels" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "channels_enabled_priority_idx" ON "app"."channels" USING btree ("enabled","priority");