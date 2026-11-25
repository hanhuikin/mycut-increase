import type { TimelineElement } from "@/timeline";

/**
 * 转写生成的字幕元素在 params 里带这个标记。
 *
 * 字幕和「文字」功能在数据上是同一种东西（都是 text track 上的 TextElement），
 * 所以「字幕面板 → 样式 → 应用到全部」不能按 track 类型圈范围——那样会连用户
 * 自己插入的文字元素一起改掉。用元素级标记区分来源：只有转写插入的字幕元素
 * 参与字幕批量样式。
 *
 * 标记放在 params 里而不是轨道上：字幕被拖到别的 text 轨道、或轨道被重命名，
 * 标记都跟着元素走。它不在 params registry 里，因此不会出现在属性面板。
 */
export const CAPTION_ELEMENT_PARAM = "isCaption";

/**
 * 标记引入之前生成的字幕没有这个字段，但 buildSubtitleTextElement 一律把
 * 名字写成 "Caption N"（硬编码英文，不随界面语言变），据此认领旧数据；
 * 用户自己插入的文字元素走的是「默认文字 / Default text」，不会落到这里。
 */
const LEGACY_CAPTION_NAME_RE = /^Caption \d+$/;

/**
 * 判定只用到这三样，收窄入参既方便测试构造数据，也让这个纯函数不依赖完整的
 * 元素类型（完整元素需要 wasm 的 MediaTime 构造）。
 */
type CaptionCandidate = Pick<TimelineElement, "type" | "name" | "params">;

export function isCaptionElement({
	element,
}: {
	element: CaptionCandidate;
}): boolean {
	if (element.type !== "text") return false;
	if (element.params[CAPTION_ELEMENT_PARAM] === true) return true;
	return LEGACY_CAPTION_NAME_RE.test(element.name);
}
