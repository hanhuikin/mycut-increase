import type { NormalizedCubicBezier } from "@/animation/types";
import type { LocaleKey } from "@/locale";

export const PRESET_MATCH_TOLERANCE = 0.02;

export interface EasingPreset {
	id: string;
	/** Literal label, used by user-saved presets. Built-ins carry labelKey instead. */
	label?: string;
	/** Dictionary key resolved at display time by the consuming component. */
	labelKey?: LocaleKey;
	value: NormalizedCubicBezier;
	isCustom?: boolean;
}

export const BUILTIN_PRESETS: EasingPreset[] = [
	{
		id: "smooth",
		labelKey: "easing.smooth" satisfies LocaleKey,
		value: [0.25, 0.1, 0.25, 1],
	},
	{
		id: "ease-out",
		labelKey: "easing.ease_out" satisfies LocaleKey,
		value: [0, 0, 0.2, 1],
	},
	{
		id: "ease-in",
		labelKey: "easing.ease_in" satisfies LocaleKey,
		value: [0.8, 0, 1, 1],
	},
	{
		id: "ease-in-out",
		labelKey: "easing.in_out" satisfies LocaleKey,
		value: [0.4, 0, 0.2, 1],
	},
	{
		id: "pop",
		labelKey: "easing.pop" satisfies LocaleKey,
		value: [0.175, 0.885, 0.32, 1.275],
	},
	{
		id: "linear",
		labelKey: "easing.linear" satisfies LocaleKey,
		value: [0, 0, 1, 1],
	},
];
