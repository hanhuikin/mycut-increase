CREATE TABLE "app"."generation_tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"batch_id" text,
	"batch_index" integer,
	"model_id" text NOT NULL,
	"prompt" text DEFAULT '' NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'submitting' NOT NULL,
	"channel_id" text,
	"protocol" text,
	"upstream_job_id" text,
	"ref_id" text,
	"excluded_channels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"has_start_image" boolean DEFAULT false NOT NULL,
	"video_url" text,
	"error_summary" text,
	"error_details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"points_frozen" integer DEFAULT 0 NOT NULL,
	"points_settled" integer,
	"created_at" timestamp NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."generation_tasks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."generation_tasks" ADD CONSTRAINT "generation_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generation_tasks_user_idx" ON "app"."generation_tasks" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "generation_tasks_status_idx" ON "app"."generation_tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "generation_tasks_batch_idx" ON "app"."generation_tasks" USING btree ("batch_id");