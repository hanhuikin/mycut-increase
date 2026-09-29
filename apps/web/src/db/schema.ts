import { sql } from "drizzle-orm";
import {
	text,
	timestamp,
	boolean,
	integer,
	index,
	uniqueIndex,
	jsonb,
	pgSchema,
} from "drizzle-orm/pg-core";
import type { VideoGenMode } from "@/services/ai-video/models";

/**
 * Dedicated schema for this app. The Docker Postgres runs as a non-superuser
 * that cannot CREATE in "public" (PostgreSQL 15+ tightened that default), so
 * the app owns its own schema instead of relying on search_path.
 */
const appSchema = pgSchema("app");

export const users = appSchema.table("users", {
	id: text("id").primaryKey(),

	// todo: implement fully anonymous sign-in for privacy
	// we don't have any auth flows currently so this is fine for now
	name: text("name").notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	image: text("image"),
	role: text("role").default("user").notNull(),
	plan: text("plan").default("free").notNull(),
	banned: boolean("banned").default(false).notNull(),
	banReason: text("ban_reason"),
	banExpires: timestamp("ban_expires"),
	twoFactorEnabled: boolean("two_factor_enabled").default(false).notNull(),
	createdAt: timestamp("created_at")
		.$defaultFn(() => /* @__PURE__ */ new Date())
		.notNull(),
	updatedAt: timestamp("updated_at")
		.$defaultFn(() => /* @__PURE__ */ new Date())
		.notNull(),
}).enableRLS();

export const twoFactors = appSchema.table("two_factors", {
	id: text("id").primaryKey(),
	secret: text("secret").notNull(),
	backupCodes: text("backup_codes").notNull(),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
}).enableRLS();

export const sessions = appSchema.table("sessions", {
	id: text("id").primaryKey(),
	expiresAt: timestamp("expires_at").notNull(),
	token: text("token").notNull().unique(),
	createdAt: timestamp("created_at").notNull(),
	updatedAt: timestamp("updated_at").notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
}).enableRLS();

export const accounts = appSchema.table("accounts", {
	id: text("id").primaryKey(),
	/** better-auth 1.7 scopes account identity by issuer. */
	issuer: text("issuer").default("").notNull(),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at"),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
	scope: text("scope"),
	password: text("password"),
	createdAt: timestamp("created_at").notNull(),
	updatedAt: timestamp("updated_at").notNull(),
}).enableRLS();

export const feedback = appSchema.table("feedback", {
	id: text("id").primaryKey(),
	message: text("message").notNull(),
	createdAt: timestamp("created_at")
		.$defaultFn(() => new Date())
		.notNull(),
});

export const verifications = appSchema.table("verifications", {
	id: text("id").primaryKey(),
	identifier: text("identifier").notNull(),
	value: text("value").notNull(),
	expiresAt: timestamp("expires_at").notNull(),
	createdAt: timestamp("created_at").$defaultFn(
		() => /* @__PURE__ */ new Date(),
	),
	updatedAt: timestamp("updated_at").$defaultFn(
		() => /* @__PURE__ */ new Date(),
	),
}).enableRLS();

// ===== 账户系统扩展：模型配置 / 点数账本 / 兑换码 / 审计 =====

export const aiModels = appSchema.table("ai_models", {
	id: text("id").primaryKey(),
	label: text("label").notNull(),
	kind: text("kind").notNull(), // video | tool | audio | local
	/** Generation modes this model serves; empty for tool/audio/local. */
	modes: jsonb("modes")
		.$type<VideoGenMode[]>()
		.default(sql`'[]'::jsonb`)
		.notNull(),
	supportsAudio: boolean("supports_audio").default(false).notNull(),
	maxDuration: integer("max_duration").default(15).notNull(),
	/** Points per second for 720p; null for per-call billing. */
	pricePerSecond720: integer("price_per_second_720"),
	pricePerSecond1080: integer("price_per_second_1080"),
	/** Points per call for tool/audio models; null for per-second billing. */
	pricePerCall: integer("price_per_call"),
	/** Optional locale keys; falls back to `label` when unset or unknown. */
	labelKey: text("label_key"),
	descriptionKey: text("description_key"),
	dailyLimit: integer("daily_limit"),
	enabled: boolean("enabled").default(true).notNull(),
	requiresPro: boolean("requires_pro").default(false).notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	updatedAt: timestamp("updated_at")
		.$defaultFn(() => new Date())
		.notNull(),
}).enableRLS();

/** System model id → the name this channel calls that model upstream. */
export type ChannelModels = Record<string, string>;

/**
 * A configured provider account: a protocol plus its connection details and the
 * models it serves.
 *
 * Several channels of the same protocol are normal — that is what lets a relay,
 * a mirror and the vendor itself coexist, each mapping the same system model to
 * whatever name it uses upstream. A request for a model goes to the enabled
 * channels that map it, lowest `priority` first.
 */
export const channels = appSchema.table(
	"channels",
	{
		id: text("id").primaryKey(),
		name: text("name").notNull(),
		/** Protocol id, e.g. "fal-queue" or "atlas". */
		protocol: text("protocol").notNull(),
		/** Blank means the protocol's built-in host. */
		baseUrl: text("base_url").default("").notNull(),
		/** Blank means no key yet — such a channel is skipped when routing. */
		apiKeyEnc: text("api_key_enc").default("").notNull(),
		apiKeySuffix: text("api_key_suffix").default("").notNull(),
		/** Which models this channel serves, and under what upstream name. */
		models: jsonb("models")
			.$type<ChannelModels>()
			.default(sql`'{}'::jsonb`)
			.notNull(),
		/** Lower runs first when several channels serve the same model. */
		priority: integer("priority").default(0).notNull(),
		enabled: boolean("enabled").default(true).notNull(),
		createdBy: text("created_by").default("").notNull(),
		updatedBy: text("updated_by").default("").notNull(),
		createdAt: timestamp("created_at")
			.$defaultFn(() => new Date())
			.notNull(),
		updatedAt: timestamp("updated_at")
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index("channels_enabled_priority_idx").on(table.enabled, table.priority),
	],
).enableRLS();

/**
 * Append-only credit ledger. The balance is always
 * sum(amount); every row snapshots balanceAfter so the books can be replayed.
 * (kind, refId) is the idempotency key: the same freeze/settle/refund can
 * never be written twice.
 */
export const creditLedger = appSchema.table(
	"credit_ledger",
	{
		id: text("id").primaryKey(),
		userId: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		amount: integer("amount").notNull(),
		balanceAfter: integer("balance_after").notNull(),
		kind: text("kind").notNull(), // grant | redeem | freeze | settle | refund | adjust
		refId: text("ref_id"),
		/**
		 * Which model the generation used. Null for top-ups and for rows written
		 * before per-model attribution existed — those bucket as "unattributed".
		 */
		modelId: text("model_id"),
		/** Seconds of video submitted, recorded on the freeze row of a job. */
		seconds: integer("seconds"),
		note: text("note").default("").notNull(),
		actorId: text("actor_id"),
		createdAt: timestamp("created_at")
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [
		index("credit_ledger_user_idx").on(table.userId, table.createdAt),
		index("credit_ledger_created_idx").on(table.createdAt),
		uniqueIndex("credit_ledger_idem_idx").on(table.kind, table.refId),
	],
).enableRLS();

export const redeemCodes = appSchema.table("redeem_codes", {
	code: text("code").primaryKey(),
	credits: integer("credits").notNull(),
	batchId: text("batch_id").notNull(),
	redeemedBy: text("redeemed_by").references(() => users.id, {
		onDelete: "set null",
	}),
	redeemedAt: timestamp("redeemed_at"),
	createdAt: timestamp("created_at")
		.$defaultFn(() => new Date())
		.notNull(),
}).enableRLS();

/** Per-user exceptions on Pro-gated models, granted by an admin. */
export const userModelGrants = appSchema.table("user_model_grants", {
	userId: text("user_id")
		.notNull()
		.references(() => users.id, { onDelete: "cascade" }),
	modelId: text("model_id")
		.notNull()
		.references(() => aiModels.id, { onDelete: "cascade" }),
	grantedBy: text("granted_by"),
	createdAt: timestamp("created_at")
		.$defaultFn(() => new Date())
		.notNull(),
}).enableRLS();

export const auditLog = appSchema.table(
	"audit_log",
	{
		id: text("id").primaryKey(),
		actorId: text("actor_id"),
		actorEmail: text("actor_email").default("").notNull(),
		action: text("action").notNull(), // elevate | ban | unban | set_role | set_plan | adjust_credits | model_create | model_update | channel_create | channel_update | channel_delete | redeem_batch
		target: text("target").default("").notNull(),
		detail: text("detail").default("").notNull(),
		ip: text("ip").default("").notNull(),
		createdAt: timestamp("created_at")
			.$defaultFn(() => new Date())
			.notNull(),
	},
	(table) => [index("audit_log_created_idx").on(table.createdAt)],
).enableRLS();
