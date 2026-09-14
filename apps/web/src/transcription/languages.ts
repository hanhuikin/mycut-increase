import type { LocaleKey } from "@/locale";

export const LANGUAGES = [
	{ code: "en", labelKey: "transcription.language.english" },
	{ code: "es", labelKey: "transcription.language.spanish" },
	{ code: "it", labelKey: "transcription.language.italian" },
	{ code: "fr", labelKey: "transcription.language.french" },
	{ code: "de", labelKey: "transcription.language.german" },
	{ code: "pt", labelKey: "transcription.language.portuguese" },
	{ code: "ru", labelKey: "transcription.language.russian" },
	{ code: "ja", labelKey: "transcription.language.japanese" },
	{ code: "zh", labelKey: "transcription.language.chinese" },
] as const satisfies ReadonlyArray<{ code: string; labelKey: LocaleKey }>;

export type Language = (typeof LANGUAGES)[number];
export type LanguageCode = Language["code"];
