CREATE TABLE "app"."model_route_secrets" (
	"model_id" text NOT NULL,
	"provider" text NOT NULL,
	"api_key_enc" text NOT NULL,
	"api_key_suffix" text DEFAULT '' NOT NULL,
	"updated_by" text DEFAULT '' NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "model_route_secrets_model_id_provider_pk" PRIMARY KEY("model_id","provider")
);
--> statement-breakpoint
ALTER TABLE "app"."model_route_secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."model_route_secrets" ADD CONSTRAINT "model_route_secrets_model_id_ai_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "app"."ai_models"("id") ON DELETE cascade ON UPDATE no action;