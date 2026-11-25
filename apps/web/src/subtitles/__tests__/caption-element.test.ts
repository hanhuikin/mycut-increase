import { describe, expect, test } from "bun:test";
import type { TimelineElement } from "@/timeline";
import { CAPTION_ELEMENT_PARAM, isCaptionElement } from "../caption-element";

/**
 * 字幕和「文字」在数据上是同一种元素（text track 上的 TextElement），字幕面板
 * 的「应用到全部」必须只作用于转写生成的字幕，否则会连带改掉用户自己插入的
 * 文字元素。这里用元素级标记区分来源。
 *
 * isCaptionElement 只看 type / name / params，所以数据按这三个字段构造即可，
 * 不必造完整的 TextElement（那需要 wasm 的 MediaTime）。
 */

function candidate({
	type = "text",
	name = "Text",
	isCaption,
	extraParams,
}: {
	type?: TimelineElement["type"];
	name?: string;
	isCaption?: boolean;
	extraParams?: Record<string, string | number | boolean>;
}): Pick<TimelineElement, "type" | "name" | "params"> {
	return {
		type,
		name,
		params: {
			content: "hello",
			...(isCaption ? { [CAPTION_ELEMENT_PARAM]: true } : {}),
			...extraParams,
		},
	};
}

describe("字幕元素标记", () => {
	test("转写生成的字幕被识别为字幕", () => {
		expect(isCaptionElement({ element: candidate({ isCaption: true }) })).toBe(
			true,
		);
	});

	test("用户插入的文字元素不算字幕", () => {
		expect(isCaptionElement({ element: candidate({}) })).toBe(false);
	});

	test("标记只认布尔真值，别的取值一律不算字幕", () => {
		expect(
			isCaptionElement({
				element: candidate({
					extraParams: { [CAPTION_ELEMENT_PARAM]: "true" },
				}),
			}),
		).toBe(false);
	});

	test("标记引入前生成的字幕（名为 Caption N）仍被认作字幕", () => {
		expect(
			isCaptionElement({ element: candidate({ name: "Caption 1" }) }),
		).toBe(true);
		expect(
			isCaptionElement({ element: candidate({ name: "Caption 42" }) }),
		).toBe(true);
	});

	test("名字只是像字幕的不算：Caption 后面必须有编号", () => {
		expect(isCaptionElement({ element: candidate({ name: "Caption" }) })).toBe(
			false,
		);
		expect(
			isCaptionElement({ element: candidate({ name: "Caption A" }) }),
		).toBe(false);
		expect(
			isCaptionElement({ element: candidate({ name: "My Caption 1" }) }),
		).toBe(false);
	});

	test("非文字元素即使带标记也不算字幕", () => {
		expect(
			isCaptionElement({
				element: candidate({ type: "graphic", isCaption: true }),
			}),
		).toBe(false);
	});
});
