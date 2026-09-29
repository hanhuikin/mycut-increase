"use client";

/**
 * AI 音乐/音效生成服务
 *
 * fal.ai 的调用在服务端（/api/ai/*），浏览器不持有密钥；服务端按模型 id
 * 找到映射了它的渠道，用渠道配置的 fal 端点（ai-audio-musicgen → fal-ai/musicgen）。
 */

import { runJob } from "@/services/ai/client";

export type AudioGenMode = "music" | "soundfx";

export interface AudioGenOptions {
	prompt: string;
	mode: AudioGenMode;
	duration?: number; // 秒，最大 30
	onProgress?: (msg: string) => void;
}

export interface AudioGenResult {
	success: boolean;
	file?: File;
	error?: string;
}

/** 根据 prompt 生成音乐或音效。 */
export async function generateAudio(
	options: AudioGenOptions,
): Promise<AudioGenResult> {
	const { prompt, mode, duration = 10, onProgress } = options;

	try {
		const isMusic = mode === "music";
		const durationSeconds = Math.min(Math.max(duration, 3), 30);
		const fullPrompt = isMusic
			? `${durationSeconds}-second music piece: ${prompt}. High quality, instrumental.`
			: `${durationSeconds}-second sound effect of ${prompt}. High quality, detailed.`;

		const { url } = await runJob({
			params: {
				modelId: "ai-audio-musicgen",
				input: { prompt: fullPrompt, duration: durationSeconds },
			},
			onProgress,
		});

		onProgress?.("下载音频...");
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`下载音频失败 (${response.status})`);
		}
		const blob = await response.blob();
		const prefix = isMusic ? "音乐" : "音效";
		const safeName = prompt.slice(0, 20).replace(/[^\w一-鿿]/g, "_");

		const file = new File([blob], `${prefix}-${safeName}.mp3`, {
			type: blob.type || "audio/mpeg",
		});

		return { success: true, file };
	} catch (error) {
		console.error("音频生成失败:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "未知错误",
		};
	}
}
