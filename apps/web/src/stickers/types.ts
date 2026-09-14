import type { LocaleKey } from "@/locale";
import type { STICKER_CATEGORIES } from "@/stickers/categories";

export type StickerCategory = keyof typeof STICKER_CATEGORIES;

export interface StickerItem {
	id: string;
	provider: string;
	/** Used for element naming and drag payloads, not for display. */
	name: string;
	/** Localized display label, when one exists for this item. */
	labelKey?: LocaleKey;
	previewUrl: string;
	metadata: Record<string, unknown>;
}

export interface StickerSearchResult {
	items: StickerItem[];
	total: number;
	hasMore: boolean;
}

export interface StickerBrowseSection {
	id: string;
	/** Localized section heading. Preferred over `title`. */
	titleKey?: LocaleKey;
	/** Raw heading, for sections whose label has no dictionary entry yet. */
	title?: string;
	items: StickerItem[];
	hasMore?: boolean;
	layout?: "grid" | "row";
	action?: {
		type: "see-all";
		category?: StickerCategory;
		sectionId?: string;
	};
}

export interface StickerBrowseResult {
	sections: StickerBrowseSection[];
}

export interface StickerProviderSearchOptions {
	limit?: number;
}

export interface StickerProviderBrowseOptions {
	page?: number;
	limit?: number;
}

export interface StickerResolveOptions {
	width?: number;
	height?: number;
}

export interface StickerProvider {
	id: string;
	search({
		query,
		options,
	}: {
		query: string;
		options?: StickerProviderSearchOptions;
	}): Promise<StickerSearchResult>;
	browse({
		options,
	}: {
		options?: StickerProviderBrowseOptions;
	}): Promise<StickerBrowseResult>;
	resolveUrl({
		stickerId,
		options,
	}: {
		stickerId: string;
		options?: StickerResolveOptions;
	}): string;
}
