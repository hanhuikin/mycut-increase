DROP TABLE "app"."model_route_secrets" CASCADE;--> statement-breakpoint
DROP TABLE "app"."provider_credentials" CASCADE;--> statement-breakpoint
DROP TABLE "app"."provider_settings" CASCADE;--> statement-breakpoint
ALTER TABLE "app"."ai_models" DROP COLUMN "route_models";