import type { LocaleKey } from "@/locale";

export const BACKGROUND_BLUR_INTENSITY_PRESETS: Array<{
	labelKey: LocaleKey;
	value: number;
}> = [
	{ labelKey: "background.blur.light", value: 100 },
	{ labelKey: "background.blur.medium", value: 200 },
	{ labelKey: "background.blur.heavy", value: 500 },
] as const;

export const DEFAULT_BACKGROUND_BLUR_INTENSITY = 10;
