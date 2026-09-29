ALTER TABLE "app"."credit_ledger" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "app"."credit_ledger" ADD COLUMN "seconds" integer;--> statement-breakpoint
CREATE INDEX "credit_ledger_created_idx" ON "app"."credit_ledger" USING btree ("created_at");