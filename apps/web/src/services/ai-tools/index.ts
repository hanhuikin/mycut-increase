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
	/** 系统模型 id（ai_models），决定渠道路由与计费单价。 */
	modelId: string;
	/** 压缩后的参考图 dataURL，按序——首位为主参考。 */
	imageDataUrls: string[];
	prompt: string;
	/** 生图尺寸，"宽x高"（已按渠道能力换算）。 */
	imageSize: string;
	/** 张数 1–4；一次调用按 张数 × 单价 计费。 */
	count?: number;
}

export interface MultiImageToImageResult {
	success: boolean;
	/** 生成的图片文件（已从 data: 链接转存）。 */
	files?: File[];
	error?: string;
}

/**
 * 多图参考生图：N 张参考图 + 提示词 → 新图。
 *
 * 走服务端同步生图路由（与 textToImage 同一条）；参考图以 data: URL 随
 * 请求体带给上游（火山格式 Seedream 支持 2–10 张多图融合）。
 */
export async function multiImageToImage(
	options: MultiImageToImageOptions,
): Promise<MultiImageToImageResult> {
	const { modelId, imageDataUrls, prompt, imageSize, count = 1 } = options;
	return generateViaImageRoute({
		modelId,
		prompt,
		imageSize,
		count,
		images: imageDataUrls,
	});
}

// ===== 文生图 =====

export interface TextToImageOptions {
	/** 系统模型 id（ai_models），决定渠道路由与计费单价。 */
	modelId: string;
	prompt: string;
	/** 请求尺寸，"宽x高"（已按渠道能力换算，每边 256–1536）。 */
	imageSize: string;
	/** 张数 1–4；一次调用按 张数 × 单价 计费。 */
	count?: number;
}

export interface TextToImageResult {
	success: boolean;
	/** 生成的图片文件（已从 data: 链接转存）。 */
	files?: File[];
	error?: string;
}

/** 错误码 → 用户可读文案（/api/ai/image/generate 的 error 字段）。 */
const IMAGE_GENERATE_ERROR_MESSAGES: Record<string, string> = {
	insufficient: "点数不足",
	model_unavailable: "生图模型不可用",
	daily_limit: "今日生成次数已达上限",
	pro_required: "该功能需要 Pro 权限",
	model_not_image: "生图模型配置异常",
	no_channel_available: "生图渠道不可用",
};

async function generateViaImageRoute({
	modelId,
	prompt,
	imageSize,
	count = 1,
	images = [],
}: {
	modelId: string;
	prompt: string;
	imageSize: string;
	count?: number;
	images?: string[];
}): Promise<{ success: boolean; files?: File[]; error?: string }> {
	try {
		const response = await fetch("/api/ai/image/generate", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				modelId,
				refId: crypto.randomUUID(),
				prompt,
				size: imageSize,
				count,
				...(images.length > 0 ? { images } : {}),
			}),
		});
		if (!response.ok) {
			const payload: unknown = await response.json().catch(() => null);
			const code =
				typeof payload === "object" &&
				payload !== null &&
				"error" in payload &&
				typeof payload.error === "string"
					? payload.error
					: "";
			throw new Error(
				IMAGE_GENERATE_ERROR_MESSAGES[code] ??
					`生图请求失败 (${response.status})`,
			);
		}
		const payload: unknown = await response.json();
		const dataUrls =
			typeof payload === "object" &&
			payload !== null &&
			"dataUrls" in payload &&
			Array.isArray(payload.dataUrls)
				? payload.dataUrls.filter(
						(url): url is string => typeof url === "string",
					)
				: [];
		if (dataUrls.length === 0) {
			throw new Error("供应商返回了空结果");
		}

		// 同一批可能一秒内多张，文件名追加随机尾避免同名覆盖
		const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "");
		const token = Math.random().toString(36).slice(2, 6);
		const files: File[] = [];
		for (let i = 0; i < dataUrls.length; i++) {
			files.push(
				await imageSourceToFile({
					url: dataUrls[i],
					name: `生图-${stamp}-${token}-${i + 1}`,
				}),
			);
		}
		return { success: true, files };
	} catch (error) {
		console.error("生图失败:", error);
		return {
			success: false,
			error: error instanceof Error ? error.message : "未知错误",
		};
	}
}

/**
 * 文生图：走服务端同步生图路由（/api/ai/image/generate）——渠道解析、
 * 点数冻结/结算/退款都在那次请求里完成，供应商同步返回成品图。
 */
export async function textToImage(
	options: TextToImageOptions,
): Promise<TextToImageResult> {
	return generateViaImageRoute(options);
}

// ===== 工具函数 =====

/** data: URL 或 http(s) 临时链接 → File（扩展名跟随实际类型）。 */
async function imageSourceToFile({
	url,
	name,
}: {
	url: string;
	name: string;
}): Promise<File> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`下载生成结果失败 (${response.status})`);
	}
	const blob = await response.blob();
	const ext =
		blob.type === "image/jpeg"
			? "jpg"
			: blob.type === "image/webp"
				? "webp"
				: "png";
	return new File([blob], `${name}.${ext}`, { type: blob.type || "image/png" });
}

async function fileToDataUrl(file: File): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(new Error("文件读取失败"));
		reader.readAsDataURL(file);
	});
}
