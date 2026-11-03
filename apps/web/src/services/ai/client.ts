"use client";

/**
 * Client-side job orchestration.
 *
 * Every provider call happens on the server (`/api/ai/*`) — channels, their
 * keys, endpoints and model mappings all live there. This module only drives
 * submit → poll and reports progress, and is shared by all three AI panels.
 */

import { settleCredits } from "@/services/billing/client";

/** Progress labels by protocol. Not localised — mirrors the server's wording. */
const PROTOCOL_LABELS: Record<string, string> = {
	ark: "火山方舟",
	atlas: "Atlas Cloud",
	wavespeed: "WaveSpeedAI",
	"fal-queue": "fal.ai",
	modelink: "七牛 Modelink",
};

/**
 * The channel name beats the protocol label: a Qiniu channel on the fal
 * protocol is not fal.ai, and the name is what the admin configured.
 */
export function jobLabel({
	channelName,
	protocol,
}: {
	channelName?: string | null;
	protocol: string;
}): string {
	return channelName?.trim() || protocolLabel(protocol);
}

export function protocolLabel(protocolId: string): string {
	return PROTOCOL_LABELS[protocolId] ?? protocolId;
}

export type PollState =
	| { state: "pending" }
	| { state: "done"; url: string }
	| { state: "failed"; error: string };

/** Poll every 2s while a job is young, then back off to 5s once it is long. */
const POLL_INTERVAL_MS = 2000;
const POLL_INTERVAL_LONG_MS = 5000;
/** Polls spent at the fast interval before backing off (~2 minutes). */
const POLL_INTERVAL_SWITCH_AFTER = 60;

/**
 * Poll budgets, in polls (the wall-clock total depends on the interval mix).
 *
 * A 150-poll (5 minute) budget used to apply to every non-Ark protocol, but
 * queue gateways are not five-minute services — Seedance 2.5 renders up to 30
 * seconds of video and Kling v3 image-to-video has been measured around nine
 * minutes — so real jobs were abandoned mid-render. Rougher but honest: the
 * default now covers roughly half an hour (60 polls at 2s + 340 at 5s), and
 * Ark, which renders the longest clips, keeps its larger budget.
 */
const DEFAULT_MAX_POLLS = 400;
const MAX_POLLS_BY_PROTOCOL: Record<string, number> = {
	ark: 450,
};

/** Interval for the poll at `index`, backing off after the early burst. */
function pollIntervalMs(index: number): number {
	return index < POLL_INTERVAL_SWITCH_AFTER
		? POLL_INTERVAL_MS
		: POLL_INTERVAL_LONG_MS;
}

export interface JobParams {
	modelId: string;
	prompt?: string;
	duration?: number | "auto";
	resolution?: string;
	aspectRatio?: string;
	generateAudio?: boolean;
	imageUrl?: string;
	/** Verbatim body for tool/audio jobs. */
	input?: Record<string, unknown>;
}

export interface SubmittedJob {
	/** The channel that accepted the job; used to exclude it when falling back. */
	channelId: string;
	/** The human-facing name of that channel, for progress labels. */
	channelName?: string;
	jobId: string;
	protocol: string;
	/** The ref this attempt was charged under — echoed back when polling. */
	refId: string;
}

/** What the server refused on, when it says so in a structured way. */
export interface JobErrorMeta {
	code?: string;
	cost?: number;
	balance?: number;
}

/** Carries the channel that failed so callers can move down the chain. */
export class JobError extends Error {
	readonly channelId: string | null;
	readonly meta: JobErrorMeta;

	constructor(
		message: string,
		channelId: string | null = null,
		meta: JobErrorMeta = {},
	) {
		super(message);
		this.name = "JobError";
		this.channelId = channelId;
		this.meta = meta;
	}
}

async function failureDetail(
	response: Response,
): Promise<{ message: string; meta: JobErrorMeta }> {
	const body = (await response.json().catch(() => null)) as {
		error?: string;
		details?: string | string[];
		cost?: number;
		balance?: number;
	} | null;
	const details = Array.isArray(body?.details)
		? body.details.join("; ")
		: body?.details;
	return {
		message: details || body?.error || `请求失败 (${response.status})`,
		meta: {
			code: body?.error,
			cost: body?.cost,
			balance: body?.balance,
		},
	};
}

export async function submitJob({
	exclude = [],
	...params
}: JobParams & { exclude?: string[] }): Promise<SubmittedJob> {
	// One ref per attempt. The server freezes the estimate against it and
	// refunds it if the job fails; a fallback to another channel is a new
	// attempt, and so a new ref — a ref is only ever usable once.
	const refId = crypto.randomUUID();
	const response = await fetch("/api/ai/generate", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ ...params, refId, exclude }),
	});

	if (!response.ok) {
		const { message, meta } = await failureDetail(response);
		throw new JobError(message, null, meta);
	}

	const body = (await response.json()) as {
		channelId: string;
		channelName?: string;
		protocol: string;
		jobId: string;
	};
	return {
		channelId: body.channelId,
		channelName: body.channelName,
		jobId: body.jobId,
		protocol: body.protocol,
		refId,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls until the job finishes, then returns the artifact URL. */
export async function pollJob({
	modelId,
	job,
	resolution,
	seconds,
	onProgress,
}: {
	modelId: string;
	job: SubmittedJob;
	resolution?: "480p" | "720p" | "1080p";
	/** What was asked for — "auto" settles at the same 5s basis as the freeze. */
	seconds?: number | "auto";
	onProgress?: (status: string) => void;
}): Promise<string> {
	const label = jobLabel({ channelName: job.channelName, protocol: job.protocol });
	const maxPolls = MAX_POLLS_BY_PROTOCOL[job.protocol] ?? DEFAULT_MAX_POLLS;
	const startedAt = Date.now();

	for (let i = 0; i < maxPolls; i++) {
		await sleep(pollIntervalMs(i));

		const response = await fetch("/api/ai/poll", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				modelId,
				channelId: job.channelId,
				jobId: job.jobId,
				// Lets the server refund this attempt when it reports a failure.
				refId: job.refId,
			}),
		});
		if (!response.ok) {
			const { meta } = await failureDetail(response);
			throw new JobError(
				`${label} 轮询失败 (${response.status})`,
				job.channelId,
				meta,
			);
		}

		const state = (await response.json()) as PollState;
		if (state.state === "done") {
			// The freeze booked the estimate at submit time; close it out at what
			// was actually produced. The settle route is idempotent per refId, and
			// a failed call only leaves the freeze in place — never lose the
			// finished artifact over it.
			try {
				await settleCredits({
					refId: job.refId,
					modelId,
					resolution: resolution ?? "720p",
					actualSeconds: typeof seconds === "number" ? seconds : undefined,
				});
			} catch (error) {
				console.error("settle failed:", error);
			}
			return state.url;
		}
		if (state.state === "failed") {
			throw new JobError(state.error, job.channelId);
		}
		if (i % 5 === 0) {
			// Vendors don't report percent done, so a percentage would be a guess
			// that undershoots badly on fast models — show elapsed time instead.
			onProgress?.(
				`${label}: 生成中... (${Math.round((Date.now() - startedAt) / 1000)}s)`,
			);
		}
	}

	// Giving up locally is invisible to the server: without an explicit release
	// the freeze booked at submit time is never closed out and the points stay
	// spent on a job nobody is waiting for. Release it before reporting.
	await releaseTask({
		modelId,
		channelId: job.channelId,
		jobId: job.jobId,
		refId: job.refId,
	});
	throw new JobError(`${label} 生成超时`, job.channelId);
}

/**
 * Hands an abandoned job back: the server refunds the freeze for this attempt.
 * Idempotent per refId, and a failure here must not mask the timeout itself.
 */
async function releaseTask({
	modelId,
	channelId,
	jobId,
	refId,
}: {
	modelId: string;
	channelId: string;
	jobId: string;
	refId: string;
}): Promise<void> {
	try {
		await fetch("/api/ai/poll", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ modelId, channelId, jobId, refId, release: true }),
		});
	} catch (error) {
		console.error("release failed:", error);
	}
}

/** Submit + poll in one step, for callers with no fallback chain of their own. */
export async function runJob({
	params,
	onProgress,
}: {
	params: JobParams;
	onProgress?: (status: string) => void;
}): Promise<{ url: string; protocol: string }> {
	onProgress?.("提交任务...");
	const job = await submitJob(params);
	onProgress?.(`${jobLabel({ channelName: job.channelName, protocol: job.protocol })}: 生成中...`);
	const url = await pollJob({ modelId: params.modelId, job, onProgress });
	return { url, protocol: job.protocol };
}
