ALTER TABLE "app"."credit_ledger" ADD COLUMN "tokens" integer;--> statement-breakpoint
ALTER TABLE "app"."generation_tasks" ADD COLUMN "usage" jsonb DEFAULT null;