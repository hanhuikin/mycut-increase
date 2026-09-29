/**
 * Protocols: how to talk to one vendor *shape*.
 *
 * A protocol is pure wire logic — it never touches the database. The caller
 * (the channel router) resolves the base URL, API key and upstream model name
 * and hands them in. Channels are configured instances of a protocol.
 *
 * Most vendors share a shape (base URL + bearer token + submit path + poll
 * path + a status field), so `defineJsonProtocol` describes those
 * declaratively: supporting a new same-shape vendor is a description, not code.
 * Vendors with a genuinely different shape (Volcano Ark's content array, fal's
 * `Key` auth and multi-shape result extraction) get a hand-written protocol.
 */

export type Resolution = "480p" | "720p" | "1080p";
export type JobFamily = "video" | "image" | "audio";

export const JOB_FAMILIES: JobFamily[] = ["video", "image", "audio"];

export function isJobFamily(value: unknown): value is JobFamily {
	return (
		value === "video" || value === "image" || value === "audio"
	);
}

/** A job to run, with everything already resolved by the channel router. */
export interface JobInput {
	/** Upstream model name — the channel's mapping for this model. */
	model: string;
	family: JobFamily;
	apiKey: string;
	/** Channel base URL, or the protocol's default when the channel is blank. */
	baseUrl: string;
	prompt?: string;
	duration?: number | "auto";
	resolution?: Resolution;
	aspectRatio?: string;
	generateAudio?: boolean;
	/** Start frame for image-to-video. Only some protocols honour it. */
	imageUrl?: string;
	/** Verbatim body for jobs a protocol doesn't build itself (image/audio). */
	body?: Record<string, unknown>;
}

/** What a later poll needs. Holds no secrets; the server re-resolves those. */
export interface JobHandle {
	protocol: string;
	/** The channel this job was submitted through. */
	channelId: string;
	/** System model id — used to re-validate the channel on poll. */
	modelId: string;
	jobId: string;
	/** Upstream model name; server-internal. */
	model: string;
	baseUrl: string;
	family: JobFamily;
}

/** A protocol's submit only reports the job id; the route composes the handle. */
export interface SubmitResult {
	jobId: string;
}

/** Injected per call so the handle itself never carries a secret. */
export interface PollCredentials {
	apiKey: string;
}

export type JobState =
	| { state: "pending" }
	| { state: "done"; url: string }
	| { state: "failed"; error: string };

export interface Protocol {
	readonly id: string;
	/** Shown as the channel's type in the admin panel. */
	readonly label: string;
	/** Job families this protocol can produce. */
	readonly families: JobFamily[];
	/** Whether a start frame can be honoured (image-to-video). */
	readonly supportsImageInput: boolean;
	readonly defaultBaseUrl: string;
	submit(input: JobInput): Promise<SubmitResult>;
	poll(handle: JobHandle, credentials: PollCredentials): Promise<JobState>;
}

/** Strip trailing slashes so paths concatenate cleanly. */
export function trimBase(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, "");
}

export async function readJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

/**
 * Walk a path into a JSON payload. Numeric segments index arrays, so
 * `["data","outputs",0]` reaches the first output URL.
 */
export function pickPath(
	source: unknown,
	path: Array<string | number>,
): unknown {
	let current: unknown = source;
	for (const key of path) {
		if (current === null || typeof current !== "object") return undefined;
		current = (current as Record<string | number, unknown>)[key];
	}
	return current;
}

/** First non-empty string among the candidate paths, or undefined. */
export function pickFirstString(
	source: unknown,
	paths: Array<Array<string | number>>,
): string | undefined {
	for (const path of paths) {
		const value = pickPath(source, path);
		if (typeof value === "string" && value) return value;
	}
	return undefined;
}

/** First defined value among the candidate paths. */
export function pickFirst(
	source: unknown,
	paths: Array<Array<string | number>>,
): unknown {
	for (const path of paths) {
		const value = pickPath(source, path);
		if (value !== undefined) return value;
	}
	return undefined;
}
