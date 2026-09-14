import type { LocalizedParamDefinition } from "../types";

export type GraphicStrokeAlign = "inside" | "center" | "outside";

export const STROKE_ALIGN_PARAM: LocalizedParamDefinition<"strokeAlign"> = {
	key: "strokeAlign",
	label: "Stroke align",
	labelKey: "prop.stroke_align",
	type: "select",
	default: "center",
	group: "stroke",
	options: [
		{ value: "inside", label: "Inside" },
		{ value: "center", label: "Center" },
		{ value: "outside", label: "Outside" },
	],
	optionLabelKeys: {
		inside: "prop.stroke_align.inside",
		center: "prop.stroke_align.center",
		outside: "prop.stroke_align.outside",
	},
};
