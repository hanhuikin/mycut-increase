"use client";

import { create } from "zustand";
import { textToImage } from "@/services/ai-tools";
import {
	resolveImageSize,
	type Img2ImgAspectRatio,
	type Img2ImgSizePreset,
} from "./img2img-store";

/**
 * 文生图的生成会话状态。独立于对话框组件存活——中途关掉对话框，
 * 生成继续、进度不丢；重开时从这里恢复（与 img2img-store 同模式）。
 */

export const TEXT2IMG_MODEL_ID = "ai-tools-text2img";

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

		const size = resolveImageSize(
			get().aspectRatio,
			get().sizePreset,
			get().customSize,
		);
		const imageSize = `${size.w}x${size.h}`;
		const finalPrompt = composeText2ImgPrompt({
			prompt,
			style: get().style,
			locale: deps.locale,
		});
		const negative = get().negative.trim();

		let imported = 0;
		const results: Text2ImgResult[] = [...placeholders];
		for (let i = 0; i < placeholders.length; i++) {
			const outcome = await textToImage({
				prompt: finalPrompt,
				negativePrompt: negative || undefined,
				aspectRatio: get().aspectRatio,
				imageSize,
			});
			if (outcome.success && outcome.file) {
				const assetId = await deps.importAsset({
					file: outcome.file,
					name: outcome.file.name,
				});
				results[i] = {
					key: placeholders[i].key,
					status: "done",
					assetId: assetId ?? undefined,
					name: outcome.file.name,
				};
				imported += 1;
				const history: Text2ImgHistoryItem[] = [
					{
						key: placeholders[i].key,
						assetId: assetId ?? undefined,
						name: outcome.file.name,
						prompt,
						aspectRatio: get().aspectRatio,
						width: size.w,
						height: size.h,
					},
					...get().history,
				].slice(0, TEXT2IMG_HISTORY_CAP);
				set({ results: [...results], history });
			} else {
				results[i] = {
					key: placeholders[i].key,
					status: "failed",
					error: outcome.error,
				};
				set({ results: [...results] });
			}
		}

		set({ running: false });
		deps.onFinished?.(imported);
	},
}));
