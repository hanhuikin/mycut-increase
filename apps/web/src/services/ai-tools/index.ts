"use client";

/**
 * AI 工具服务（抠像 + 擦除）
 *
 * fal.ai 的调用在服务端（/api/ai/*），浏览器不持有密钥；服务端按模型 id
 * 找到映射了它的渠道，用渠道配置的 fal 端点（ai-tools-remove-bg → fal-ai/birefnet，
 * ai-tools-inpaint → fal-ai/flux-lora/inpainting）。
 */

import { runJob } from "@/services/ai/client";

// ===== AI 抠像 =====

export interface RemoveBGOptions {
	imageFile: File;
	onProgress?: (msg: string) => void;
}

export interface RemoveBGResult {
	success: boolean;
	file?: File;
	error?: string;
}

/** 去除图片背景，生成透明 PNG（fal-ai/birefnet，约 2-5 秒）。 */
export async function removeBackground(
	options: RemoveBGOptions,
): Promise<RemoveBGResult> {
	const { imageFile, onProgress } = options;

	try {
		onProgress?.("上传图片...");
		const dataUrl = await fileToDataUrl(imageFile);

		const { url } = await runJob({
			params: {
				modelId: "ai-tools-remove-bg",
				input: {
					image_url: dataUrl,
					model: "General Use (Light)",
					operating_resolution: "1024x1024",
					output_format: "png",
					refine_foreground: true,
				},
			},
			onProgress,
		});

		onProgress?.("下载结果...");
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`下载抠像结果失败 (${response.status})`);
		}
		const blob = await response.blob();
		const file = new File(
			[blob],
			`抠图-${imageFile.name.replace(/\.[^.]+$/, "")}.png`,
			{ type: "image/png" },
		);

		return { success: true, file };
	} catch (error) {
		console.error("抠像失败:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "未知错误",
		};
	}
}

// ===== AI 擦除 =====

export interface InpaintEraseOptions {
	imageFile: File;
	maskDataUrl: string; // Canvas 涂鸦生成的遮罩图（白色=擦除区域，黑色=保留区域）
	prompt?: string; // 可选：文字描述要擦除的内容
	onProgress?: (msg: string) => void;
}

export interface InpaintEraseResult {
	success: boolean;
	file?: File;
	error?: string;
}

/**
 * AI 智能擦除：涂鸦遮罩 + 可选文字提示
 * fal-ai/flux-lora/inpainting 要求 image_url + mask_url + 可选 prompt。
 */
export async function inpaintErase(
	options: InpaintEraseOptions,
): Promise<InpaintEraseResult> {
	const { imageFile, maskDataUrl, prompt, onProgress } = options;

	try {
		onProgress?.("上传图片和遮罩...");
		const imageDataUrl = await fileToDataUrl(imageFile);

		const input: Record<string, unknown> = {
			image_url: imageDataUrl,
			mask_url: maskDataUrl,
			num_inference_steps: 28,
			guidance_scale: 7.5,
		};

		if (prompt) {
			input.prompt = `Remove ${prompt}. Keep everything else exactly the same. Fill the removed area naturally with the surrounding background.`;
			input.negative_prompt =
				"blurry, distorted, low quality, different style, text, watermark";
		}

		const { url } = await runJob({
			params: { modelId: "ai-tools-inpaint", input },
			onProgress,
		});

		onProgress?.("下载结果...");
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`下载擦除结果失败 (${response.status})`);
		}
		const blob = await response.blob();
		const ext = imageFile.name.match(/\.([^.]+)$/)?.[1] || "png";
		const file = new File(
			[blob],
			`擦除-${imageFile.name.replace(/\.[^.]+$/, "")}.${ext}`,
			{ type: blob.type || "image/png" },
		);

		return { success: true, file };
	} catch (error) {
		console.error("擦除失败:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "未知错误",
		};
	}
}

// ===== 多图参考生图 =====

export interface MultiImageToImageOptions {
	/** 压缩后的参考图 dataURL，按序——首位为主参考。 */
	imageDataUrls: string[];
	prompt: string;
	aspectRatio?: "1:1" | "16:9" | "3:4" | "9:16";
	/** 生图尺寸，"宽x高"（如 "1024x576"），由比例×尺寸档/自定义合成。 */
	imageSize?: string;
	onProgress?: (msg: string) => void;
}

export interface MultiImageToImageResult {
	success: boolean;
	file?: File;
	error?: string;
}

/**
 * 多图参考生图：N 张参考图 + 提示词 → 一张新图。
 *
 * input 逐字透传上游（fal 系多参考生图端点，具体端点由渠道按 modelId 映射），
 * 与 removeBackground 同构；每次调用生成一张、冻结一次点数。
 */
export async function multiImageToImage(
	options: MultiImageToImageOptions,
): Promise<MultiImageToImageResult> {
	const {
		imageDataUrls,
		prompt,
		aspectRatio = "1:1",
		imageSize,
		onProgress,
	} = options;

	try {
		const { url } = await runJob({
			params: {
				modelId: "ai-tools-img2img-multi",
				input: {
					prompt,
					image_urls: imageDataUrls,
					aspect_ratio: aspectRatio,
					...(imageSize ? { image_size: imageSize } : {}),
				},
			},
			onProgress,
		});

		onProgress?.("下载结果...");
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`下载生成结果失败 (${response.status})`);
		}
		const blob = await response.blob();
		const file = new File(
			[blob],
			`多图生图-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, "")}.png`,
			{ type: blob.type || "image/png" },
		);

		return { success: true, file };
	} catch (error) {
		console.error("多图生图失败:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "未知错误",
		};
	}
}

// ===== 文生图 =====

export interface TextToImageOptions {
	prompt: string;
	/** 负面提示词（不希望出现的内容）；上游不支持时由渠道侧忽略。 */
	negativePrompt?: string;
	aspectRatio?: "1:1" | "16:9" | "3:4" | "9:16";
	/** 生图尺寸，"宽x高"（如 "1024x576"），由比例×尺寸档/自定义合成。 */
	imageSize?: string;
	onProgress?: (msg: string) => void;
}

export interface TextToImageResult {
	success: boolean;
	file?: File;
	error?: string;
}

/**
 * 文生图：纯文字提示 → 一张新图。
 *
 * input 逐字透传上游（fal 系文生图端点，具体端点由渠道按 modelId 映射），
 * 与 multiImageToImage 同构；每次调用生成一张、冻结一次点数，
 * 多张由前端串行循环（同 img2img 模式，先到先显示）。
 */
export async function textToImage(
	options: TextToImageOptions,
): Promise<TextToImageResult> {
	const {
		prompt,
		negativePrompt,
		aspectRatio = "1:1",
		imageSize,
		onProgress,
	} = options;

	try {
		const { url } = await runJob({
			params: {
				modelId: "ai-tools-text2img",
				input: {
					prompt,
					aspect_ratio: aspectRatio,
					...(imageSize ? { image_size: imageSize } : {}),
					...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
				},
			},
			onProgress,
		});

		onProgress?.("下载结果...");
		const response = await fetch(url);
		if (!response.ok) {
			throw new Error(`下载生成结果失败 (${response.status})`);
		}
		const blob = await response.blob();
		// 同一批可能一秒内多张，文件名追加随机尾避免同名覆盖
		const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "");
		const file = new File(
			[blob],
			`文生图-${stamp}-${Math.random().toString(36).slice(2, 6)}.png`,
			{ type: blob.type || "image/png" },
		);

		return { success: true, file };
	} catch (error) {
		console.error("文生图失败:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "未知错误",
		};
	}
}

// ===== 工具函数 =====

async function fileToDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(new Error("文件读取失败"));
		reader.readAsDataURL(file);
	});
}
