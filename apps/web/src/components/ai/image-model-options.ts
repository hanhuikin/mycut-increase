"use client";

import type { LocaleKey } from "@/locale";

/**
 * 生图对话框的「模型」选项 = ai_models 里的系统模型 id（kind=tool，
 * image family）。每个 id 决定渠道路由与计费单价；界面按
 * billing.models 是否收录来过滤，没配渠道/价格的模型不出现。
 */

export interface ImageModelOption {
	id: string;
	labelKey: LocaleKey;
}

/** 文生图可选模型：Seedream（国内优先）、Gemini（海外）。 */
export const TEXT2IMG_MODEL_OPTIONS: ImageModelOption[] = [
	{ id: "ai-tools-text2img", labelKey: "ai_t2i.model_seedream" },
	{ id: "ai-tools-text2img-gemini", labelKey: "ai_t2i.model_gemini" },
];

/** 多图参考生图可选模型：要求上游支持 ≥2 张参考图（Seedream 多图融合）。 */
export const IMG2IMG_MODEL_OPTIONS: ImageModelOption[] = [
	{ id: "ai-tools-img2img-multi", labelKey: "ai_img2img.model_seedream_multi" },
];
