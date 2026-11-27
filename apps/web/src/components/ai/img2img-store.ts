"use client";

import { create } from "zustand";
import { multiImageToImage } from "@/services/ai-tools";
import { compressImageToDataUrl } from "@/utils/image";
import { resolveImageRequestSize } from "./image-size";

/**
 * 多图生图的生成会话状态。独立于对话框组件存活——中途关掉对话框，
 * 生成继续、进度不丢；重开时从这里恢复。
 */

export const IMG2IMG_MAX_SLOTS = 4;
export const IMG2IMG_MODEL_ID = "ai-tools-img2img-multi";

/**
 * 生图尺寸能力（与模型匹配）。M1 为客户端常量；后续随 billing models
 * 服务端下发（模型目录 maxImageEdge/maxImagePixels/imageStep）时迁走。
 */
export const IMG2IMG_SIZE_CAPS = {
	minEdge: 256,
	maxEdge: 1536,
	maxPixels: 1536 * 1536,
	step: 64,
} as const;

export type Img2ImgAspectRatio = "1:1" | "16:9" | "3:4" | "9:16";
/** 长边基准档；"custom" 使用 customSize。 */
export type Img2ImgSizePreset = 768 | 1024 | 1536 | "custom";

const ASPECT_RATIOS: Record<Img2ImgAspectRatio, [number, number]> = {
	"1:1": [1, 1],
	"16:9": [16, 9],
	"3:4": [3, 4],
	"9:16": [9, 16],
};

const snapEdge = (value: number): number => {
	const { step, minEdge, maxEdge } = IMG2IMG_SIZE_CAPS;
	return Math.min(maxEdge, Math.max(minEdge, Math.round(value / step) * step));
};

/** 长边基准 + 画面比例 → 具体像素（每边吸附到能力步进）。 */
export function computeImageSize(
	aspectRatio: Img2ImgAspectRatio,
	longEdge: number,
): { w: number; h: number } {
	const [rw, rh] = ASPECT_RATIOS[aspectRatio];
	const w = rw >= rh ? longEdge : (longEdge * rw) / rh;
	const h = rh >= rw ? longEdge : (longEdge * rh) / rw;
	return { w: snapEdge(w), h: snapEdge(h) };
}

/** 当前生效尺寸：档位随比例换算；自定义档用吸附后的宽高。 */
export function resolveImageSize(
	aspectRatio: Img2ImgAspectRatio,
	sizePreset: Img2ImgSizePreset,
	customSize: { w: number; h: number } | null,
): { w: number; h: number } {
	if (sizePreset === "custom" && customSize) {
		return customSize;
	}
	const longEdge = sizePreset === "custom" ? 1024 : sizePreset;
	return computeImageSize(aspectRatio, longEdge);
}

export function aspectRatioValue(r: Img2ImgAspectRatio): number {
	return ASPECT_RATIOS[r][0] / ASPECT_RATIOS[r][1];
}

export interface Img2ImgSlot {
	/** React key，与素材 id 无关（同一素材可多次添加）。 */
	key: string;
	name: string;
	file: File;
	/** 仅用于槽位预览的 objectURL。 */
	previewUrl: string;
	/** 来自素材库时的资产 id，用于「素材已删除」校验。 */
	fromAssetId?: string;
}

export type Img2ImgResult = {
	key: string;
	status: "generating" | "done" | "failed";
	/** 入库后的资产 id（成功时）。 */
	assetId?: string;
	name?: string;
	error?: string;
};

export interface Img2ImgGenerateDeps {
	/** 把完成的 File 存入项目素材库，返回资产 id。 */
	importAsset: (args: { file: File; name: string }) => Promise<string | null>;
	/** 一批全部结束（无论成败）后回调，n = 成功入库张数。 */
	onFinished?: (imported: number) => void;
}

interface Img2ImgState {
	open: boolean;
	/** 当前选中的生图模型（ai_models id），决定渠道路由与单价。 */
	modelId: string;
	slots: Img2ImgSlot[];
	results: Img2ImgResult[];
	prompt: string;
	aspectRatio: Img2ImgAspectRatio;
	sizePreset: Img2ImgSizePreset;
	/** 自定义尺寸（已吸附到步进并过校验的生效值）。 */
	customSize: { w: number; h: number } | null;
	numImages: 1 | 2;
	running: boolean;
	openWith: (slots: Img2ImgSlot[]) => void;
	setOpen: (open: boolean) => void;
	close: () => void;
	setModelId: (modelId: string) => void;
	setPrompt: (prompt: string) => void;
	setAspectRatio: (aspectRatio: Img2ImgAspectRatio) => void;
	setSizePreset: (preset: Img2ImgSizePreset) => void;
	setCustomSize: (size: { w: number; h: number }) => void;
	setNumImages: (numImages: 1 | 2) => void;
	addSlots: (slots: Img2ImgSlot[]) => void;
	removeSlot: (key: string) => void;
	moveSlot: (from: number, to: number) => void;
	generate: (deps: Img2ImgGenerateDeps) => Promise<void>;
	clearResults: () => void;
}

export const useImg2ImgStore = create<Img2ImgState>((set, get) => ({
	open: false,
	modelId: IMG2IMG_MODEL_ID,
	slots: [],
	results: [],
	prompt: "",
	aspectRatio: "1:1",
	sizePreset: 1024,
	customSize: null,
	numImages: 1,
	running: false,

	openWith: (slots) =>
		set({
			open: true,
			slots: slots.slice(0, IMG2IMG_MAX_SLOTS),
			results: [],
		}),
	setOpen: (open) => set({ open }),
	close: () => set({ open: false }),
	setModelId: (modelId) => set({ modelId }),
	setPrompt: (prompt) => set({ prompt }),
	setAspectRatio: (aspectRatio) => set({ aspectRatio }),
	setSizePreset: (sizePreset) => set({ sizePreset }),
	setCustomSize: (customSize) => set({ customSize, sizePreset: "custom" }),
	setNumImages: (numImages) => set({ numImages }),

	addSlots: (slots) => {
		const { slots: prev } = get();
		const room = IMG2IMG_MAX_SLOTS - prev.length;
		if (room <= 0) return;
		set({ slots: [...prev, ...slots.slice(0, room)] });
	},

	removeSlot: (key) =>
		set((state) => {
			const slot = state.slots.find((s) => s.key === key);
			if (slot) {
				URL.revokeObjectURL(slot.previewUrl);
			}
			return { slots: state.slots.filter((s) => s.key !== key) };
		}),

	moveSlot: (from, to) =>
		set((state) => {
			if (
				from === to ||
				from < 0 ||
				to < 0 ||
				from >= state.slots.length ||
				to >= state.slots.length
			) {
				return state;
			}
			const slots = [...state.slots];
			const [moved] = slots.splice(from, 1);
			slots.splice(to, 0, moved);
			return { slots };
		}),

	clearResults: () => set({ results: [] }),

	generate: async (deps) => {
		const state = get();
		if (state.running) return;
		const ready = state.slots;
		if (ready.length < 2 || !state.prompt.trim()) return;

		const placeholders: Img2ImgResult[] = Array.from(
			{ length: state.numImages },
			(_, i) => ({
				key: `${Date.now()}-${i}`,
				status: "generating" as const,
			}),
		);
		set({ running: true, results: placeholders });

		// 压缩放生成时：参考图 dataURL 体积是请求体的大头，长边 1536 + JPEG 0.9
		// 后单图 ~300KB。失败标记整批失败（不冻结——冻结发生在 runJob 内部）。
		let imageDataUrls: string[];
		try {
			imageDataUrls = [];
			for (const slot of ready) {
				imageDataUrls.push(await compressImageToDataUrl({ file: slot.file }));
			}
		} catch {
			set({
				running: false,
				results: placeholders.map((p) => ({
					...p,
					status: "failed" as const,
					error: "compress_failed",
				})),
			});
			deps.onFinished?.(0);
			return;
		}

		const size = resolveImageRequestSize({
			aspectRatio: get().aspectRatio,
			sizePreset: get().sizePreset,
			customSize: get().customSize,
		});
		const imageSize = `${size.w}x${size.h}`;

		// 同步路由：一次调用带全部参考图、出全部张数（按张数计费）
		const outcome = await multiImageToImage({
			modelId: get().modelId,
			imageDataUrls,
			prompt: get().prompt.trim(),
			imageSize,
			count: placeholders.length,
		});
		const files = outcome.success ? (outcome.files ?? []) : [];
		let imported = 0;
		const results: Img2ImgResult[] = [...placeholders];
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
		for (let i = 0; i < placeholders.length; i++) {
			const file = files[i];
			if (!file) {
				results[i] = {
					key: placeholders[i].key,
					status: "failed",
					error: "生成数量不足",
				};
				set({ results: [...results] });
				continue;
			}
			const assetId = await deps.importAsset({ file, name: file.name });
			results[i] = {
				key: placeholders[i].key,
				status: "done",
				assetId: assetId ?? undefined,
				name: file.name,
			};
			imported += 1;
			set({ results: [...results] });
		}

		set({ running: false });
		deps.onFinished?.(imported);
	},
}));

/** 自定义尺寸校验：返回 null = 合法（吸附后），否则为给用户的失败原因 key。 */
export function validateCustomSize(
	w: number,
	h: number,
): {
	w: number;
	h: number;
} | null {
	const { minEdge, maxEdge, step, maxPixels } = IMG2IMG_SIZE_CAPS;
	if (
		!Number.isFinite(w) ||
		!Number.isFinite(h) ||
		w < minEdge ||
		h < minEdge ||
		w > maxEdge ||
		h > maxEdge
	) {
		return null;
	}
	const sw = snapEdge(w);
	const sh = snapEdge(h);
	if (sw * sh > maxPixels) {
		return null;
	}
	return { w: sw, h: sh };
}
