import { describe, expect, test } from "bun:test";

import {
	composeText2ImgPrompt,
	getText2ImgStyleSuffix,
	TEXT2IMG_HISTORY_CAP,
} from "../text2img-store";

/**
 * 文生图提示词组装：用户原文 + 风格后缀（按界面语言）。
 * 不碰 @/wasm（bun 多文件同跑时那里会在模块初始化期 TDZ）。
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
