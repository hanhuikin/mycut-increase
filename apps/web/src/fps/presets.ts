import type { LocaleKey } from "@/locale";

export const FPS_PRESETS = [
	{ value: "24", labelKey: "fps.preset.24" satisfies LocaleKey },
	{ value: "25", labelKey: "fps.preset.25" satisfies LocaleKey },
	{ value: "30", labelKey: "fps.preset.30" satisfies LocaleKey },
	{ value: "60", labelKey: "fps.preset.60" satisfies LocaleKey },
	{ value: "120", labelKey: "fps.preset.120" satisfies LocaleKey },
] as const;
