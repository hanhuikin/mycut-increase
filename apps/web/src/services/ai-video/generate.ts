"use client";

/**
 * AI 视频生成
 *
 * 厂商调用全部在服务端（/api/ai/*）：浏览器既不持有渠道密钥，也不持有
 * 「模型 → 上游模型名」的映射。这里只做编排 —— 提交、轮询，以及轮询失败时
 * 排除该渠道后重新提交（提交阶段的多渠道尝试由服务端完成）。
 */

import {
	JobError,
	pollJob,
	protocolLabel,
	submitJob,
} from "@/services/ai/client";

export interface VideoGenOptions {
	/** Model id from the billing API; the server picks the channels. */
	modelId: string;
	prompt: string;
	duration?: number | "auto";
	resolution?: "480p" | "720p" | "1080p";
	aspectRatio?: string;
	generateAudio?: boolean;
	/** Start frame. Setting it restricts the chain — see below. */
	imageUrl?: string;
	onProgress?: (status: string) => void;
}

export interface VideoGenResult {
	success: boolean;
	videoUrl?: string;
	error?: string;
	/** Protocol id that produced the video, or the last one tried. */
	protocol: string;
	/**
	 * Why the server refused a run that never started: `insufficient`,
	 * `pro_required`, `daily_limit`, `unauthenticated`. Carried up so the panel
	 * can answer with the credit dialog or the right message instead of a
	 * generic failure.
	 */
	code?: string;
	cost?: number;
	balance?: number;
}

/**
 * A safety bound only: the loop ends when the server reports no channel left,
 * which happens once every channel has been excluded. Channel count is the
 * admin's to decide, so there is no fixed attempt limit.
 */
const SAFETY_MAX_ATTEMPTS = 25;

export async function generateVideo(
	options: VideoGenOptions,
): Promise<VideoGenResult> {
	const exclude: string[] = [];
	let lastProtocol = "ark";

	for (let attempt = 0; attempt < SAFETY_MAX_ATTEMPTS; attempt++) {
		let job: Awaited<ReturnType<typeof submitJob>>;
		try {
			job = await submitJob({
				modelId: options.modelId,
				prompt: options.prompt,
				duration: options.duration,
				resolution: options.resolution,
				aspectRatio: options.aspectRatio,
				generateAudio: options.generateAudio,
				imageUrl: options.imageUrl,
				exclude,
			});
		} catch (error) {
			// Every remaining channel was tried and refused — nothing left to do.
			// A refusal from the server (no credits, Pro-only, over the daily cap)
			// arrives on the first attempt and ends the loop with its code intact.
			const meta = error instanceof JobError ? error.meta : {};
			return {
				success: false,
				error: error instanceof Error ? error.message : "未知错误",
				protocol: lastProtocol,
				code: meta.code,
				cost: meta.cost,
				balance: meta.balance,
			};
		}

		lastProtocol = job.protocol;
		options.onProgress?.(`${protocolLabel(job.protocol)}: 提交任务...`);

		try {
			const videoUrl = await pollJob({
				modelId: options.modelId,
				job,
				onProgress: options.onProgress,
			});
			return { success: true, videoUrl, protocol: job.protocol };
		} catch (error) {
			const message = error instanceof Error ? error.message : "未知错误";
			// 图生视频只有宣告支持起始帧的协议能跑；其余厂商会静默丢掉起始帧，
			// 生成一个与用户上传图片无关的视频。宁可失败也不降级。
			if (options.imageUrl) {
				return { success: false, error: message, protocol: job.protocol };
			}
			exclude.push(job.channelId);
			options.onProgress?.(
				`${protocolLabel(job.protocol)} 失败，切换下一个渠道...`,
			);
		}
	}

	return {
		success: false,
		error: "切换渠道次数过多，已中止。请在管理面板中检查渠道配置",
		protocol: lastProtocol,
	};
}
