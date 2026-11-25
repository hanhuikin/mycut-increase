import type { TransitionDefinition, TransitionDirection } from "../types";

/**
 * 9 个内置转场预设。参数刻意做少：
 * - 方向（推移 / 擦除）
 * - 羽化（擦除 / 圆形）
 * - 强度（缩放 / 模糊）
 * 时长是元素本身的 duration，由时间轴上的块宽决定。
 */

const DIRECTION_PARAM = {
	key: "direction",
	label: "Direction",
	labelKey: "prop.direction",
	type: "select",
	default: "left",
	options: [
		{ value: "left", label: "Left" },
		{ value: "right", label: "Right" },
		{ value: "up", label: "Up" },
		{ value: "down", label: "Down" },
	],
	optionLabelKeys: {
		left: "prop.direction.left",
		right: "prop.direction.right",
		up: "prop.direction.up",
		down: "prop.direction.down",
	},
} as const satisfies TransitionDefinition["params"][number];

const FEATHER_PARAM = {
	key: "feather",
	label: "Feather",
	labelKey: "prop.feather",
	type: "number",
	default: 8,
	min: 0,
	max: 50,
	step: 1,
} as const satisfies TransitionDefinition["params"][number];

const INTENSITY_PARAM = {
	key: "intensity",
	label: "Intensity",
	labelKey: "prop.intensity",
	type: "number",
	default: 40,
	min: 0,
	max: 100,
	step: 1,
} as const satisfies TransitionDefinition["params"][number];

export const DEFAULT_TRANSITION_DURATION_SECONDS = 0.5;

export const dissolveTransition: TransitionDefinition = {
	type: "dissolve",
	name: "Dissolve",
	labelKey: "transitions.dissolve",
	keywords: ["dissolve", "crossfade", "fade", "叠化", "淡入淡出"],
	family: "dissolve",
	defaultDurationSeconds: DEFAULT_TRANSITION_DURATION_SECONDS,
	params: [],
};

export const fadeBlackTransition: TransitionDefinition = {
	type: "fade-black",
	name: "Fade to Black",
	labelKey: "transitions.fade_black",
	keywords: ["fade", "black", "黑场", "淡出"],
	family: "fade-black",
	defaultDurationSeconds: DEFAULT_TRANSITION_DURATION_SECONDS,
	params: [],
};

export const fadeWhiteTransition: TransitionDefinition = {
	type: "fade-white",
	name: "Fade to White",
	labelKey: "transitions.fade_white",
	keywords: ["fade", "white", "白场", "闪白"],
	family: "fade-white",
	defaultDurationSeconds: DEFAULT_TRANSITION_DURATION_SECONDS,
	params: [],
};

export const slideTransition: TransitionDefinition = {
	type: "push",
	name: "Push",
	labelKey: "transitions.push",
	keywords: ["push", "slide", "推移", "滑动"],
	family: "push",
	defaultDurationSeconds: DEFAULT_TRANSITION_DURATION_SECONDS,
	params: [DIRECTION_PARAM],
};

export const wipeTransition: TransitionDefinition = {
	type: "wipe",
	name: "Wipe",
	labelKey: "transitions.wipe",
	keywords: ["wipe", "擦除", "划像"],
	family: "wipe",
	defaultDurationSeconds: DEFAULT_TRANSITION_DURATION_SECONDS,
	params: [DIRECTION_PARAM, FEATHER_PARAM],
};

export const circleTransition: TransitionDefinition = {
	type: "circle",
	name: "Circle",
	labelKey: "transitions.circle",
	keywords: ["circle", "iris", "圆形", "圆形扩展"],
	family: "circle",
	defaultDurationSeconds: DEFAULT_TRANSITION_DURATION_SECONDS,
	params: [FEATHER_PARAM],
};

export const zoomTransition: TransitionDefinition = {
	type: "zoom",
	name: "Zoom",
	labelKey: "transitions.zoom",
	keywords: ["zoom", "scale", "缩放"],
	family: "zoom",
	defaultDurationSeconds: DEFAULT_TRANSITION_DURATION_SECONDS,
	params: [INTENSITY_PARAM],
};

export const rotateTransition: TransitionDefinition = {
	type: "rotate",
	name: "Rotate",
	labelKey: "transitions.rotate",
	keywords: ["rotate", "spin", "旋转"],
	family: "rotate",
	defaultDurationSeconds: DEFAULT_TRANSITION_DURATION_SECONDS,
	params: [INTENSITY_PARAM],
};

export const blurTransition: TransitionDefinition = {
	type: "blur",
	name: "Blur",
	labelKey: "transitions.blur",
	keywords: ["blur", "defocus", "模糊"],
	family: "blur",
	defaultDurationSeconds: DEFAULT_TRANSITION_DURATION_SECONDS,
	params: [INTENSITY_PARAM],
};

export const defaultTransitions: TransitionDefinition[] = [
	dissolveTransition,
	fadeBlackTransition,
	fadeWhiteTransition,
	slideTransition,
	wipeTransition,
	circleTransition,
	zoomTransition,
	rotateTransition,
	blurTransition,
];

/** 方向参数的取值守卫：存储里可能是任意字符串。 */
export function readTransitionDirection({
	value,
}: {
	value: unknown;
}): TransitionDirection {
	switch (value) {
		case "right":
			return "right";
		case "up":
			return "up";
		case "down":
			return "down";
		default:
			return "left";
	}
}
