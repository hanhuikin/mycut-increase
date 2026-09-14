import type { LocaleKey } from "@/locale";

/**
 * Category id -> locale key. The keys are load-bearing (they double as provider
 * ids and back `StickerCategory`), so only the values are localized.
 */
export const STICKER_CATEGORIES = {
	all: "stickers.category.all",
	// v0.4.0
	// logos: "stickers.category.logos",
	flags: "stickers.category.flags",
	shapes: "stickers.category.shapes",
} as const satisfies Record<string, LocaleKey>;
