"use client";

import {
	resolveImageSize,
	type Img2ImgAspectRatio,
	type Img2ImgSizePreset,
} from "./img2img-store";

/**
 * 生图请求尺寸换算。
 *
 * 七牛国内 Seedream 要求总像素 ≥ 921,600（约 92 万）；海外 Gemini 对大图
 * 无副作用，所以统一策略：面积不足时保持比例放大（每边取偶、≤1536）。
 * 对话框的尺寸展示也走这里，保证「所见尺寸 = 实际提交尺寸」。
 */
export const MIN_IMAGE_PIXELS = 921_600;

export function resolveImageRequestSize({
	aspectRatio,
	sizePreset,
	customSize,
}: {
	aspectRatio: Img2ImgAspectRatio;
	sizePreset: Img2ImgSizePreset;
	customSize: { w: number; h: number } | null;
}): { w: number; h: number } {
	const base = resolveImageSize(aspectRatio, sizePreset, customSize);
	const area = base.w * base.h;
	if (area >= MIN_IMAGE_PIXELS) return base;
	const scale = Math.sqrt(MIN_IMAGE_PIXELS / area);
	const ceilEven = (value: number) =>
		Math.min(1536, Math.ceil((value * scale) / 2) * 2);
	return { w: ceilEven(base.w), h: ceilEven(base.h) };
}
