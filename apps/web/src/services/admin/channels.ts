import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { type ChannelModels, channels } from "@/db/schema";
import {
	type JobFamily,
	type Protocol,
	getProtocol,
} from "@/services/ai/protocols";
import { decryptSecret, encryptSecret, secretSuffix } from "./secrets";

/** Model kind → the job family it produces. `local` never leaves the browser. */
const FAMILY_BY_KIND: Record<string, JobFamily | undefined> = {
	video: "video",
	tool: "image",
	audio: "audio",
	local: undefined,
};

export function familyForKind(kind: string): JobFamily | undefined {
	return FAMILY_BY_KIND[kind];
}

/** Blank is allowed (meaning "use the protocol's host"); otherwise http(s). */
export function isValidBaseUrl(value: string): boolean {
	if (!value.trim()) return true;
	try {
		const url = new URL(value.trim());
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

/** A channel as the admin panel sees it. Never carries the key. */
export interface ChannelView {
	id: string;
	name: string;
	protocol: string;
	protocolLabel: string;
	/** Blank means the protocol's built-in host. */
	baseUrl: string;
	models: ChannelModels;
	priority: number;
	enabled: boolean;
	hasKey: boolean;
	keySuffix: string;
	updatedBy: string;
	updatedAt: Date;
}

function toView(row: typeof channels.$inferSelect): ChannelView {
	return {
		id: row.id,
		name: row.name,
		protocol: row.protocol,
		protocolLabel: getProtocol(row.protocol)?.label ?? row.protocol,
		baseUrl: row.baseUrl,
		models: row.models,
		priority: row.priority,
		enabled: row.enabled,
		hasKey: Boolean(row.apiKeyEnc),
		keySuffix: row.apiKeySuffix,
		updatedBy: row.updatedBy,
		updatedAt: row.updatedAt,
	};
}

export interface ChannelInput {
	name: string;
	protocol: string;
	baseUrl: string;
	/** Blank leaves an existing key untouched; ignored on create. */
	apiKey: string;
	models: ChannelModels;
	priority: number;
	enabled: boolean;
}

/**
 * The channels a fresh install starts with: one per protocol this replaced.
 * Priorities reproduce the old fixed order (ark → atlas → wavespeed → fal) and
 * the mappings mirror the per-model routes the models used to carry.
 */
export const DEFAULT_CHANNELS: Array<{
	name: string;
	protocol: string;
	priority: number;
	models: ChannelModels;
}> = [
	{
		name: "火山方舟",
		protocol: "ark",
		priority: 0,
		models: { "seedance-2.0": "doubao-seedance-2-0-260128" },
	},
	{
		name: "Atlas Cloud",
		protocol: "atlas",
		priority: 10,
		models: {
			"seedance-2.0": "bytedance/seedance-2.0/text-to-video",
			"seedance-2.0-turbo": "bytedance/seedance-2.0/text-to-video",
		},
	},
	{
		name: "WaveSpeedAI",
		protocol: "wavespeed",
		priority: 20,
		models: {
			"seedance-2.0": "bytedance/seedance-2.0/text-to-video-turbo",
			"seedance-2.0-turbo": "bytedance/seedance-2.0/text-to-video-turbo",
		},
	},
	{
		name: "fal.ai",
		protocol: "fal-queue",
		priority: 30,
		models: {
			"seedance-2.0": "bytedance/seedance-2.0/text-to-video",
			"seedance-2.0-turbo": "bytedance/seedance-2.0/text-to-video",
			"ai-tools-remove-bg": "fal-ai/birefnet",
			"ai-tools-inpaint": "fal-ai/flux-lora/inpainting",
			"ai-audio-musicgen": "fal-ai/musicgen",
		},
	},
];

/**
 * Seed the defaults when there are none. Only runs on an empty table, so a
 * default channel the admin deleted stays deleted.
 */
export async function ensureChannelsSeeded(): Promise<void> {
	const existing = await db
		.select({ id: channels.id })
		.from(channels)
		.limit(1);
	if (existing.length > 0) return;
	await db
		.insert(channels)
		.values(
			DEFAULT_CHANNELS.map((seed) => ({
				id: crypto.randomUUID(),
				name: seed.name,
				protocol: seed.protocol,
				priority: seed.priority,
				models: seed.models,
				createdBy: "system",
				updatedBy: "system",
			})),
		)
		.onConflictDoNothing();
}

export async function listChannels(): Promise<ChannelView[]> {
	await ensureChannelsSeeded();
	const rows = await db
		.select()
		.from(channels)
		.orderBy(asc(channels.priority), asc(channels.createdAt));
	return rows.map(toView);
}

export async function getChannel(id: string): Promise<ChannelView | null> {
	const rows = await db
		.select()
		.from(channels)
		.where(eq(channels.id, id))
		.limit(1);
	return rows[0] ? toView(rows[0]) : null;
}

export async function createChannel({
	input,
	actor,
}: {
	input: ChannelInput;
	actor: string;
}): Promise<ChannelView | null> {
	const key = input.apiKey.trim();
	const id = crypto.randomUUID();
	await db.insert(channels).values({
		id,
		name: input.name,
		protocol: input.protocol,
		baseUrl: input.baseUrl,
		apiKeyEnc: key ? encryptSecret(key) : "",
		apiKeySuffix: key ? secretSuffix(key) : "",
		models: input.models,
		priority: input.priority,
		enabled: input.enabled,
		createdBy: actor,
		updatedBy: actor,
	});
	return getChannel(id);
}

export async function updateChannel({
	id,
	input,
	actor,
}: {
	id: string;
	input: ChannelInput;
	actor: string;
}): Promise<ChannelView | null> {
	const key = input.apiKey.trim();
	await db
		.update(channels)
		.set({
			name: input.name,
			protocol: input.protocol,
			baseUrl: input.baseUrl,
			models: input.models,
			priority: input.priority,
			enabled: input.enabled,
			updatedBy: actor,
			updatedAt: new Date(),
			// An empty key field means "leave the stored key alone".
			...(key
				? { apiKeyEnc: encryptSecret(key), apiKeySuffix: secretSuffix(key) }
				: {}),
		})
		.where(eq(channels.id, id));
	return getChannel(id);
}

export async function deleteChannel(id: string): Promise<boolean> {
	const rows = await db
		.delete(channels)
		.where(eq(channels.id, id))
		.returning({ id: channels.id });
	return rows.length > 0;
}

/** The decrypted key for a channel. Server-side only. */
export async function getChannelCredential(id: string): Promise<string | null> {
	const rows = await db
		.select({ apiKeyEnc: channels.apiKeyEnc })
		.from(channels)
		.where(eq(channels.id, id))
		.limit(1);
	const stored = rows[0]?.apiKeyEnc;
	return stored ? decryptSecret(stored) : null;
}

/** A channel ready to run a job: protocol, upstream name, key and base URL. */
export interface RoutedChannel {
	channel: ChannelView;
	protocol: Protocol;
	upstreamModel: string;
	apiKey: string;
	baseUrl: string;
}

/**
 * The channels that can serve a model, best first.
 *
 * A channel qualifies when it is enabled, maps this model, has a key, speaks a
 * protocol that produces this model's family, and — for image-to-video — can
 * honour a start frame. Order comes from `priority`; ties break by creation
 * order so routing is deterministic.
 */
export async function resolveChannelChain({
	modelId,
	kind,
	imageUrl,
}: {
	modelId: string;
	kind: string;
	imageUrl?: string;
}): Promise<RoutedChannel[]> {
	await ensureChannelsSeeded();
	const family = familyForKind(kind);
	if (!family) return [];

	const rows = await db
		.select()
		.from(channels)
		.where(eq(channels.enabled, true))
		.orderBy(asc(channels.priority), asc(channels.createdAt));

	const chain: RoutedChannel[] = [];
	for (const row of rows) {
		const upstreamModel = row.models[modelId];
		if (!upstreamModel) continue;
		if (!row.apiKeyEnc) continue;
		const protocol = getProtocol(row.protocol);
		if (!protocol || !protocol.families.includes(family)) continue;
		if (imageUrl && !protocol.supportsImageInput) continue;
		chain.push({
			channel: toView(row),
			protocol,
			upstreamModel,
			apiKey: decryptSecret(row.apiKeyEnc),
			baseUrl: row.baseUrl,
		});
	}
	return chain;
}

/** One channel's relationship to one model. */
export interface ChannelCoverageEntry {
	channelId: string;
	name: string;
	protocolLabel: string;
	priority: number;
	enabled: boolean;
	hasKey: boolean;
	/** Enabled, keyed, and its protocol can run this model's family. */
	usable: boolean;
}

/**
 * How each model is covered by channels — for the model list and drawer.
 *
 * `kindOf` supplies each model's kind, because whether a channel can actually
 * run a model depends on the protocol supporting that model's family, which
 * only the caller's model registry knows.
 */
export async function channelCoverage({
	kindOf,
}: {
	kindOf: (modelId: string) => string | undefined;
}): Promise<Map<string, ChannelCoverageEntry[]>> {
	await ensureChannelsSeeded();
	const rows = await db
		.select()
		.from(channels)
		.orderBy(asc(channels.priority), asc(channels.createdAt));

	const coverage = new Map<string, ChannelCoverageEntry[]>();
	for (const row of rows) {
		const protocol = getProtocol(row.protocol);
		for (const modelId of Object.keys(row.models)) {
			const family = familyForKind(kindOf(modelId) ?? "");
			const entry: ChannelCoverageEntry = {
				channelId: row.id,
				name: row.name,
				protocolLabel: protocol?.label ?? row.protocol,
				priority: row.priority,
				enabled: row.enabled,
				hasKey: Boolean(row.apiKeyEnc),
				usable: Boolean(
					row.enabled &&
						row.apiKeyEnc &&
						protocol &&
						family &&
						protocol.families.includes(family),
				),
			};
			coverage.set(modelId, [...(coverage.get(modelId) ?? []), entry]);
		}
	}
	return coverage;
}
