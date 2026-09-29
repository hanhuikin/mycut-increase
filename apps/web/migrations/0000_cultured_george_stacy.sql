CREATE TABLE "app"."accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"issuer" text DEFAULT '' NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp,
	"refresh_token_expires_at" timestamp,
	"scope" text,
	"password" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."accounts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."ai_models" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"kind" text NOT NULL,
	"price_per_second_720" integer,
	"price_per_second_1080" integer,
	"price_per_call" integer,
	"provider_route" text DEFAULT '' NOT NULL,
	"daily_limit" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"requires_pro" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."ai_models" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text,
	"actor_email" text DEFAULT '' NOT NULL,
	"action" text NOT NULL,
	"target" text DEFAULT '' NOT NULL,
	"detail" text DEFAULT '' NOT NULL,
	"ip" text DEFAULT '' NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."audit_log" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."credit_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"amount" integer NOT NULL,
	"balance_after" integer NOT NULL,
	"kind" text NOT NULL,
	"ref_id" text,
	"note" text DEFAULT '' NOT NULL,
	"actor_id" text,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."credit_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"message" text NOT NULL,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."redeem_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"credits" integer NOT NULL,
	"batch_id" text NOT NULL,
	"redeemed_by" text,
	"redeemed_at" timestamp,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."redeem_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"expires_at" timestamp NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL,
	CONSTRAINT "sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
ALTER TABLE "app"."sessions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."two_factors" (
	"id" text PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."two_factors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."user_model_grants" (
	"user_id" text NOT NULL,
	"model_id" text NOT NULL,
	"granted_by" text,
	"created_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."user_model_grants" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'user' NOT NULL,
	"plan" text DEFAULT 'free' NOT NULL,
	"banned" boolean DEFAULT false NOT NULL,
	"ban_reason" text,
	"ban_expires" timestamp,
	"two_factor_enabled" boolean DEFAULT false NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "app"."users" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "app"."verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp,
	"updated_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "app"."verifications" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app"."accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."credit_ledger" ADD CONSTRAINT "credit_ledger_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."redeem_codes" ADD CONSTRAINT "redeem_codes_redeemed_by_users_id_fk" FOREIGN KEY ("redeemed_by") REFERENCES "app"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."two_factors" ADD CONSTRAINT "two_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_model_grants" ADD CONSTRAINT "user_model_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."user_model_grants" ADD CONSTRAINT "user_model_grants_model_id_ai_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "app"."ai_models"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_created_idx" ON "app"."audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "credit_ledger_user_idx" ON "app"."credit_ledger" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_idem_idx" ON "app"."credit_ledger" USING btree ("kind","ref_id");