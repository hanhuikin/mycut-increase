import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { aiModels, userModelGrants } from "@/db/schema";
import {
	type ChannelCoverageEntry,
	channelCoverage,
} from "@/services/admin/channels";
import type { VideoGenMode } from "@/services/ai-video/models";

export interface AdminModelConfig {
	id: string;
	label: string;
	kind: "video" | "tool" | "audio" | "local";
	modes: VideoGenMode[];
	supportsAudio: boolean;
	maxDuration: number;
	pricePerSecond720: number | null;
	pricePerSecond1080: number | null;
	pricePerCall: number | null;
	labelKey: string | null;
	descriptionKey: string | null;
	dailyLimit: number | null;
	enabled: boolean;
	requiresPro: boolean;
	sortOrder: number;
}

/** Admin-editable fields. `id` is fixed once created. */
export type EditableModelFields = Partial<
	Pick<
		AdminModelConfig,
		| "label"
		| "labelKey"
		| "descriptionKey"
		| "modes"
		| "supportsAudio"
		| "maxDuration"
		| "pricePerSecond720"
		| "pricePerSecond1080"
		| "pricePerCall"
		| "dailyLimit"
		| "enabled"
		| "requiresPro"
		| "sortOrder"
	>
>;

/**
 * The model catalogue. Which upstream model each one maps to is no longer here
 * — that lives on the channel that serves it (see services/admin/channels).
 */
const DEFAULT_MODELS: AdminModelConfig[] = [
	{
		id: "seedance-2.0",
		label: "Seedance 2.0",
		kind: "video",
		modes: ["text-to-video", "image-to-video"],
		supportsAudio: true,
		maxDuration: 15,
		pricePerSecond720: 10,
		pricePerSecond1080: 25,
		pricePerCall: null,
		labelKey: "ai_video.model_seedance",
		descriptionKey: "ai_video.model_seedance_desc",
		dailyLimit: null,
		enabled: true,
		requiresPro: false,
		sortOrder: 0,
	},
	{
		id: "seedance-2.0-turbo",
		label: "Seedance 2.0 Turbo",
		kind: "video",
		modes: ["text-to-video"],
		supportsAudio: false,
		maxDuration: 10,
		pricePerSecond720: 5,
		pricePerSecond1080: null,
		pricePerCall: null,
		labelKey: "ai_video.model_seedance_turbo",
		descriptionKey: "ai_video.model_seedance_turbo_desc",
		dailyLimit: null,
		enabled: true,
		requiresPro: false,
		sortOrder: 1,
	},
	{
		id: "ai-tools-remove-bg",
		label: "AI 抠像",
		kind: "tool",
		modes: [],
		supportsAudio: false,
		maxDuration: 15,
		pricePerSecond720: null,
		pricePerSecond1080: null,
		pricePerCall: 30,
		labelKey: null,
		descriptionKey: null,
		dailyLimit: null,
		enabled: true,
		requiresPro: false,
		sortOrder: 2,
	},
	{
		id: "ai-tools-inpaint",
		label: "AI 擦除",
		kind: "tool",
		modes: [],
		supportsAudio: false,
		maxDuration: 15,
		pricePerSecond720: null,
		pricePerSecond1080: null,
		pricePerCall: 50,
		labelKey: null,
		descriptionKey: null,
		dailyLimit: null,
		enabled: true,
		requiresPro: false,
		sortOrder: 3,
	},
	{
		id: "ai-audio-musicgen",
		label: "MusicGen 音频",
		kind: "audio",
		modes: [],
		supportsAudio: false,
		maxDuration: 30,
		pricePerSecond720: null,
		pricePerSecond1080: null,
		pricePerCall: 20,
		labelKey: null,
		descriptionKey: null,
		dailyLimit: null,
		enabled: false,
		requiresPro: false,
		sortOrder: 4,
	},
	{
		id: "whisper-local",
		label: "Whisper 转写",
		kind: "local",
		modes: [],
		supportsAudio: false,
		maxDuration: 15,
		pricePerSecond720: null,
		pricePerSecond1080: null,
		pricePerCall: null,
		// Runs in the browser; never routed to a channel.
		labelKey: null,
		descriptionKey: null,
		dailyLimit: null,
		enabled: true,
		requiresPro: false,
		sortOrder: 5,
	},
];

/**
 * Insert the defaults, and repair rows that predate the capability columns.
 *
 * The `where` guard means a row is only touched while it still sits at the
 * capability-column defaults, so admin edits always win. Only those columns are
 * written on conflict — never prices, labels, or switches.
 *
 * This has to happen here rather than in a migration: `db:push` applies the
 * schema without running migration SQL, so a migration-only backfill would
 * silently leave existing rows empty.
 *
 * Once it has run in this process it cannot need to run again — the upsert only
 * ever writes the six fixed default rows — so a flag skips the statement on
 * every subsequent read (this runs per /api/billing/models call).
 */
let modelsSeeded = false;

export async function ensureModelsSeeded(): Promise<void> {
	if (modelsSeeded) return;
	await db
		.insert(aiModels)
		.values(DEFAULT_MODELS)
		.onConflictDoUpdate({
			target: aiModels.id,
			set: {
				modes: sql`excluded.modes`,
				supportsAudio: sql`excluded.supports_audio`,
				maxDuration: sql`excluded.max_duration`,
				labelKey: sql`excluded.label_key`,
				descriptionKey: sql`excluded.description_key`,
			},
			where: sql`${aiModels.modes} = '[]'::jsonb`,
		});
	modelsSeeded = true;
}

function toConfig(row: typeof aiModels.$inferSelect): AdminModelConfig {
	return {
		id: row.id,
		label: row.label,
		kind: row.kind as AdminModelConfig["kind"],
		modes: row.modes,
		supportsAudio: row.supportsAudio,
		maxDuration: row.maxDuration,
		pricePerSecond720: row.pricePerSecond720,
		pricePerSecond1080: row.pricePerSecond1080,
		pricePerCall: row.pricePerCall,
		labelKey: row.labelKey,
		descriptionKey: row.descriptionKey,
		dailyLimit: row.dailyLimit,
		enabled: row.enabled,
		requiresPro: row.requiresPro,
		sortOrder: row.sortOrder,
	};
}

/** What a client is allowed to see: no provider routing config. */
export interface PublicModelConfig {
	id: string;
	label: string;
	kind: AdminModelConfig["kind"];
	modes: VideoGenMode[];
	supportsAudio: boolean;
	maxDuration: number;
	pricePerSecond720: number | null;
	pricePerSecond1080: number | null;
	pricePerCall: number | null;
	labelKey: string | null;
	descriptionKey: string | null;
	enabled: boolean;
	requiresPro: boolean;
	sortOrder: number;
}

/**
 * Allow-list, not an omit-list: nothing about routing may reach a client — the
 * server resolves the channel, its endpoint and its key. A future column
 * shouldn't leak by default either.
 */
export function toPublicModel(model: AdminModelConfig): PublicModelConfig {
	return {
		id: model.id,
		label: model.label,
		kind: model.kind,
		modes: model.modes,
		supportsAudio: model.supportsAudio,
		maxDuration: model.maxDuration,
		pricePerSecond720: model.pricePerSecond720,
		pricePerSecond1080: model.pricePerSecond1080,
		pricePerCall: model.pricePerCall,
		labelKey: model.labelKey,
		descriptionKey: model.descriptionKey,
		enabled: model.enabled,
		requiresPro: model.requiresPro,
		sortOrder: model.sortOrder,
	};
}

/**
 * Adds each model's channel coverage. Channels are the only place routing,
 * endpoints and keys live, so the admin panel reads coverage here (read-only)
 * and edits it on the channel page.
 */
export interface AdminModelWithChannels extends AdminModelConfig {
	channels: ChannelCoverageEntry[];
}

export async function listModels({
	enabledOnly = false,
}: {
	enabledOnly?: boolean;
}): Promise<AdminModelWithChannels[]> {
	await ensureModelsSeeded();
	const rows = await db
		.select()
		.from(aiModels)
		.orderBy(asc(aiModels.sortOrder));
	const kindById = new Map(rows.map((row) => [row.id, row.kind]));
	const coverage = await channelCoverage({
		kindOf: (modelId) => kindById.get(modelId),
	});
	return rows
		.map(toConfig)
		.map((model) => ({ ...model, channels: coverage.get(model.id) ?? [] }))
		.filter((model) => model.enabled || !enabledOnly);
}

/** One model plus its channel coverage, for the admin panel. */
export async function getModelDetail({
	id,
}: {
	id: string;
}): Promise<AdminModelWithChannels | null> {
	const model = await getModel({ id });
	if (!model) {
		return null;
	}
	const coverage = await channelCoverage({
		kindOf: (modelId) => (modelId === id ? model.kind : undefined),
	});
	return { ...model, channels: coverage.get(id) ?? [] };
}

/** Model ids are stable identifiers: lowercase, and fixed once created. */
const MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

export function isValidModelId(id: string): boolean {
	return MODEL_ID_PATTERN.test(id);
}

/**
 * Create a model. It starts disabled and unrouted — a new model is not runnable
 * until the admin wires up a route and a key in the drawer, which the list
 * shows as "no usable key" rather than failing silently at generation time.
 *
 * `id` is the primary key and is referenced by the credit ledger and per-user
 * grants, so it can never change afterwards.
 */
export async function createModel({
	id,
	label,
	kind,
}: {
	id: string;
	label: string;
	kind: AdminModelConfig["kind"];
}): Promise<AdminModelConfig | null> {
	if (!isValidModelId(id) || (await getModel({ id }))) {
		return null;
	}
	const rows = await db
		.select({ max: sql<number>`coalesce(max(${aiModels.sortOrder}), -1)` })
		.from(aiModels);
	await db
		.insert(aiModels)
		.values({
			id,
			label,
			kind,
			enabled: false,
			requiresPro: false,
			sortOrder: Number(rows[0]?.max ?? -1) + 1,
		})
		.onConflictDoNothing();
	return getModel({ id });
}

export async function getModel({
	id,
}: {
	id: string;
}): Promise<AdminModelConfig | null> {
	const rows = await db
		.select()
		.from(aiModels)
		.where(eq(aiModels.id, id))
		.limit(1);
	const row = rows[0];
	return row ? toConfig(row) : null;
}

/** Points for one generation, frozen before the task runs. */
export function estimateModelCost({
	model,
	resolution,
	seconds,
}: {
	model: AdminModelConfig;
	resolution: "480p" | "720p" | "1080p";
	seconds: number;
}): number {
	if (model.kind === "local") {
		return 0;
	}
	if (model.pricePerCall != null) {
		return model.pricePerCall;
	}
	const perSecond =
		resolution === "1080p" && model.pricePerSecond1080 != null
			? model.pricePerSecond1080
			: (model.pricePerSecond720 ?? 0);
	return perSecond * seconds;
}

/** Admin edits a model; hot-effective. Never inserts — the set is fixed. */
export async function updateModel({
	id,
	patch,
}: {
	id: string;
	patch: EditableModelFields;
}): Promise<AdminModelConfig | null> {
	await db
		.update(aiModels)
		.set({ ...patch, updatedAt: new Date() })
		.where(eq(aiModels.id, id));
	return getModel({ id });
}

/** Whether this user holds a per-user exception for one Pro-gated model. */
export async function hasModelGrant({
	userId,
	modelId,
}: {
	userId: string;
	modelId: string;
}): Promise<boolean> {
	const rows = await db
		.select({ modelId: userModelGrants.modelId })
		.from(userModelGrants)
		.where(
			and(
				eq(userModelGrants.userId, userId),
				eq(userModelGrants.modelId, modelId),
			),
		)
		.limit(1);
	return rows.length > 0;
}

/** Per-user exception for a Pro-gated model. */
export async function grantModelToUser({
	userId,
	modelId,
	grantedBy,
}: {
	userId: string;
	modelId: string;
	grantedBy: string;
}): Promise<void> {
	await db
		.insert(userModelGrants)
		.values({ userId, modelId, grantedBy })
		.onConflictDoNothing();
}

export async function revokeUserModelGrant({
	userId,
	modelId,
}: {
	userId: string;
	modelId: string;
}): Promise<void> {
	await db
		.delete(userModelGrants)
		.where(
			and(
				eq(userModelGrants.userId, userId),
				eq(userModelGrants.modelId, modelId),
			),
		);
}
