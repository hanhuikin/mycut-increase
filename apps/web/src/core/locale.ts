import { getLocale, type Locale, type LocaleStrings } from "@/locale";

/**
 * Resolves translations outside React.
 *
 * `LocaleProvider` persists the user's choice in `localStorage` under
 * "locale", so plain modules (managers, commands) can read the same source of
 * truth instead of hardcoding a single dictionary. Falls back to Chinese,
 * matching `LocaleProvider`'s initial state.
 */
export function getActiveTranslations(): LocaleStrings {
	if (typeof window !== "undefined" && window.localStorage) {
		const savedLocale = localStorage.getItem("locale") as Locale | null;
		if (savedLocale === "zh" || savedLocale === "en") {
			return getLocale(savedLocale);
		}
	}

	return getLocale("zh");
}
