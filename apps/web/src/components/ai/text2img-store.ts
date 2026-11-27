"use client";

import { create } from "zustand";
import { textToImage } from "@/services/ai-tools";
import { resolveImageRequestSize } from "./image-size";
import {
	type Img2ImgAspectRatio,
	type Img2ImgSizePreset,
} from "./img2img-store";

/**
 * 文生图的生成会话状态。独立于对话框组件存活——中途关掉对话框，
 * 生成继续、进度不丢；重开时从这里恢复（与 img2img-store 同模式）。
 */

export const TEXT2IMG_MODEL_ID = "ai-tools-text2img";
/** 文生图第二模型：海外 Gemini 3 Pro Image（七牛海外·生图渠道）。 */
export const TEXT2IMG_GEMINI_MODEL_ID = "ai-tools-text2img-gemini";

/** 会话级历史上限；素材库才是结果的持久层。 */
export const TEXT2IMG_HISTORY_CAP = 40;

export type Text2ImgNumImages = 1 | 2 | 4;

/** 风格预设：仅是提示词后缀，不另传参；生成时按界面语言拼接。 */
export type Text2ImgStyleKey =
	| "none"
	| "photo"
	| "illustration"
	| "3d"
	| "anime"
	| "ink";

/** 风格词映射（设计稿 ⑥）：key → 界面语言对应的后缀文案。 */
const STYLE_SUFFIXES: Record<Exclude<Text2ImgStyleKey, "none">, { zh: string; en: string }> = {
	photo: {
		zh: "，摄影质感，自然光影，高细节，真实感",
		en: ", photorealistic, natural lighting, highly detailed",
	},
	illustration: {
		zh: "，扁平插画风格，色块干净，构图清晰",
		en: ", flat illustration, clean shapes, clear composition",
	},
	"3d": {
		zh: "，3D 渲染，柔和棚光，OC 渲染质感",
		en: ", 3D render, soft studio lighting, octane style",
	},
	anime: {
		zh: "，动漫风格，赛璐璐上色，清晰线稿",
		en: ", anime style, cel shading, clean lineart",
	},
	ink: {
		zh: "，中国水墨画，留白意境，墨色浓淡",
		en: ", Chinese ink painting, minimalist, ink wash",
	},
};

/** 查询风格后缀文案（供对话框提示行展示）；无风格返回 null。 */
export function getText2ImgStyleSuffix({
	style,
	locale,
}: {
	style: Text2ImgStyleKey;
	locale: "zh" | "en";
}): string | null {
	if (style === "none") return null;
	return STYLE_SUFFIXES[style][locale];
}

/** 组装最终发给模型的提示词：用户原文 + 风格后缀（按界面语言）。 */
export function composeText2ImgPrompt({
	prompt,
	style,
	locale,
}: {
	prompt: string;
	style: Text2ImgStyleKey;
	locale: "zh" | "en";
}): string {
	const trimmed = prompt.trim();
	if (style === "none") return trimmed;
	const suffix = STYLE_SUFFIXES[style][locale];
	if (!trimmed) {
		// 空提示词 + 风格：去掉开头的分隔符（zh「，」/ en「, 」），避免以标点开头
		return suffix.replace(/^[,，]\s*/, "").trim();
	}
	return `${trimmed}${suffix}`;
}

export type Text2ImgResultStatus = "generating" | "done" | "failed";

export interface Text2ImgResult {
	/** React key，与素材 id 无关。 */
	key: string;
	status: Text2ImgResultStatus;
	/** 入库后的资产 id（成功时）。 */
	assetId?: string;
	name?: string;
	error?: string;
}

export interface Text2ImgHistoryItem {
	key: string;
	/** 素材库资产 id（展示时经 editor.media 解析 url；素材被删则置灰）。 */
	assetId?: string;
	name?: string;
	/** 用户原始提示词（不含风格后缀）。 */
	prompt: string;
	aspectRatio: Img2ImgAspectRatio;
	width: number;
	height: number;
}

export interface Text2ImgGenerateDeps {
	/** 界面语言：决定风格后缀文案。 */
	locale: "zh" | "en";
	/** 把完成的 File 存入项目素材库，返回资产 id。 */
	importAsset: (args: { file: File; name: string }) => Promise<string | null>;
	/** 一批全部结束（无论成败）后回调，n = 成功入库张数。 */
	onFinished?: (imported: number) => void;
}

export interface Text2ImgState {
	open: boolean;
	/** 当前选中的生图模型（ai_models id），决定渠道路由与单价。 */
	modelId: string;
	prompt: string;
	style: Text2ImgStyleKey;
	negative: string;
	aspectRatio: Img2ImgAspectRatio;
	/** 长边基准档；"custom" 使用 customSize（与 img2img 共用常量与换算）。 */
	sizePreset: Img2ImgSizePreset;
	customSize: { w: number; h: number } | null;
	numImages: Text2ImgNumImages;
	running: boolean;
	results: Text2ImgResult[];
	history: Text2ImgHistoryItem[];
	setOpen: (open: boolean) => void;
	close: () => void;
	setModelId: (modelId: string) => void;
	setPrompt: (prompt: string) => void;
	setStyle: (style: Text2ImgStyleKey) => void;
	setNegative: (negative: string) => void;
	setAspectRatio: (aspectRatio: Img2ImgAspectRatio) => void;
	setSizePreset: (preset: Img2ImgSizePreset) => void;
	setCustomSize: (size: { w: number; h: number }) => void;
	setNumImages: (numImages: Text2ImgNumImages) => void;
	generate: (deps: Text2ImgGenerateDeps) => Promise<void>;
}

export const useText2ImgStore = create<Text2ImgState>((set, get) => ({
	open: false,
	modelId: TEXT2IMG_MODEL_ID,
	prompt: "",
	style: "none",
	negative: "",
	aspectRatio: "1:1",
	sizePreset: 1024,
	customSize: null,
	numImages: 1,
	running: false,
	results: [],
	history: [],

	setOpen: (open) => set({ open }),
	close: () => set({ open: false }),
	setModelId: (modelId) => set({ modelId }),
	setPrompt: (prompt) => set({ prompt }),
	setStyle: (style) => set({ style }),
	setNegative: (negative) => set({ negative }),
	setAspectRatio: (aspectRatio) => set({ aspectRatio }),
	setSizePreset: (sizePreset) => set({ sizePreset }),
	setCustomSize: (customSize) => set({ customSize, sizePreset: "custom" }),
	setNumImages: (numImages) => set({ numImages }),

	generate: async (deps) => {
		const state = get();
		if (state.running) return;
		const prompt = state.prompt.trim();
		if (!prompt) return;

		const placeholders: Text2ImgResult[] = Array.from(
			{ length: state.numImages },
			(_, i) => ({
				key: `${Date.now()}-${i}`,
				status: "generating" as const,
			}),
		);
		set({ running: true, results: placeholders });

		const size = resolveImageRequestSize({
			aspectRatio: get().aspectRatio,
			sizePreset: get().sizePreset,
			customSize: get().customSize,
		});
		const finalPrompt = composeText2ImgPrompt({
			prompt,
			style: get().style,
			locale: deps.locale,
		});

		// 同步路由：一次调用出全部张数（按张数计费），失败整批标记可重试
		const outcome = await textToImage({
			modelId: get().modelId,
			prompt: finalPrompt,
			imageSize: `${size.w}x${size.h}`,
			count: placeholders.length,
		});
		const files = outcome.success ? (outcome.files ?? []) : [];
		if (files.length === 0) {
			set({
				running: false,
				results: placeholders.map((p) => ({
					...p,
					status: "failed" as const,
					error: outcome.error,
				})),
			});
			deps.onFinished?.(0);
			return;
		}

		let imported = 0;
		const results: Text2ImgResult[] = [...placeholders];
		let history = [...get().history];
		for (let i = 0; i < placeholders.length; i++) {
			const file = files[i];
			if (!file) {
				// 供应商少返了图：剩余占位标记失败，可整批重试
				results[i] = {
					key: placeholders[i].key,
					status: "failed",
					error: "生成数量不足",
				};
				set({ results: [...results] });
				continue;
			}
			const assetId = await deps.importAsset({
				file,
				name: file.name,
			});
			results[i] = {
				key: placeholders[i].key,
				status: "done",
				assetId: assetId ?? undefined,
				name: file.name,
			};
			imported += 1;
			history = [
				{
					key: placeholders[i].key,
					assetId: assetId ?? undefined,
					name: file.name,
					prompt,
					aspectRatio: get().aspectRatio,
					width: size.w,
					height: size.h,
				},
				...history,
			].slice(0, TEXT2IMG_HISTORY_CAP);
			set({ results: [...results], history });
		}

		set({ running: false });
		deps.onFinished?.(imported);
	},
}));
