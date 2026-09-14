import { zh } from "./zh";
import { en } from "./en";

export type Locale = "zh" | "en";

/** Every translation key, derived from the Chinese dictionary (source of truth). */
export type LocaleKey = keyof typeof zh;

/**
 * A complete dictionary. Widened to `string` on purpose: `zh` is declared
 * `as const`, so using `typeof zh` directly would demand that every other
 * locale repeat the Chinese literals.
 */
export type LocaleStrings = Record<LocaleKey, string>;

/** Alias used by components that build labels from a dictionary. */
export type Translations = LocaleStrings;

const locales: Record<Locale, LocaleStrings> = {
  zh,
  en,
};

export function getLocale(locale: Locale): LocaleStrings {
  return locales[locale] || locales.zh;
}

export { zh, en };
