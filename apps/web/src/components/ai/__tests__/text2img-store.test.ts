import { describe, expect, test } from "bun:test";

import {
	MIN_IMAGE_PIXELS,
	resolveImageRequestSize,
} from "../image-size";
import {
	composeText2ImgPrompt,
	getText2ImgStyleSuffix,
	TEXT2IMG_HISTORY_CAP,
} from "../text2img-store";

/**
 * 文生图提示词组装与请求尺寸换算（不碰 @/wasm，单测用普通数字构造）。
 */

describe("composeText2ImgPrompt", () => {
	test("无风格时返回去除首尾空白的原文", () => {
		expect(
			composeText2ImgPrompt({ prompt: "  江南水乡  ", style: "none", locale: "zh" }),
		).toBe("江南水乡");
	});

	test("选风格时拼接对应语言的后缀", () => {
		const zh = composeText2ImgPrompt({
			prompt: "江南水乡",
			style: "photo",
			locale: "zh",
		});
		expect(zh).toBe("江南水乡，摄影质感，自然光影，高细节，真实感");

		const en = composeText2ImgPrompt({
			prompt: "canal town",
			style: "photo",
			locale: "en",
		});
		expect(en).toBe("canal town, photorealistic, natural lighting, highly detailed");
	});

	test("空提示词 + 风格：只留后缀", () => {
		expect(
			composeText2ImgPrompt({ prompt: "  ", style: "ink", locale: "zh" }),
		).toBe("中国水墨画，留白意境，墨色浓淡");
	});

	test("每个非 none 风格都能取到中英文后缀", () => {
		for (const style of ["photo", "illustration", "3d", "anime", "ink"] as const) {
			for (const locale of ["zh", "en"] as const) {
				expect(getText2ImgStyleSuffix({ style, locale })).toBeTruthy();
			}
		}
		expect(getText2ImgStyleSuffix({ style: "none", locale: "zh" })).toBeNull();
	});
});

describe("会话历史上限", () => {
	test("上限为 40（素材库才是持久层）", () => {
		expect(TEXT2IMG_HISTORY_CAP).toBe(40);
	});
});

describe("请求尺寸换算（Seedream 最低像素要求）", () => {
	test("面积已达标：原样返回", () => {
		expect(
			resolveImageRequestSize({ aspectRatio: "1:1", sizePreset: 1024, customSize: null }),
		).toEqual({ w: 1024, h: 1024 });
		expect(
			resolveImageRequestSize({ aspectRatio: "1:1", sizePreset: 1536, customSize: null }),
		).toEqual({ w: 1536, h: 1536 });
	});

	test("面积不足：保持比例放大到 ≥92 万像素", () => {
		const size = resolveImageRequestSize({
			aspectRatio: "16:9",
			sizePreset: 1024,
			customSize: null,
		});
		// 1024x576（59 万）→ 1280x720（92.16 万）
		expect(size).toEqual({ w: 1280, h: 720 });

		const portrait = resolveImageRequestSize({
			aspectRatio: "3:4",
			sizePreset: 768,
			customSize: null,
		});
		expect(portrait.w * portrait.h).toBeGreaterThanOrEqual(MIN_IMAGE_PIXELS);
		expect(portrait.w / portrait.h).toBeCloseTo(3 / 4, 2);
	});

	test("自定义尺寸同样放大", () => {
		const size = resolveImageRequestSize({
			aspectRatio: "1:1",
			sizePreset: "custom",
			customSize: { w: 512, h: 512 },
		});
		expect(size.w * size.h).toBeGreaterThanOrEqual(MIN_IMAGE_PIXELS);
	});

	test("放大不超过 1536 长边", () => {
		const size = resolveImageRequestSize({
			aspectRatio: "1:1",
			sizePreset: "custom",
			customSize: { w: 700, h: 700 },
		});
		expect(size.w).toBeLessThanOrEqual(1536);
		expect(size.h).toBeLessThanOrEqual(1536);
		expect(size.w * size.h).toBeGreaterThanOrEqual(MIN_IMAGE_PIXELS);
	});
});
