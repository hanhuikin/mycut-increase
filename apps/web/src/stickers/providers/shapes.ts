import { buildGraphicPreviewUrl, buildDefaultGraphicInstance, graphicsRegistry, registerDefaultGraphics } from "@/graphics";
import type { LocaleKey } from "@/locale";
import type { ParamValues } from "@/params";
import { buildStickerId, parseStickerId } from "../sticker-id";
import type {
	StickerBrowseResult,
	StickerItem,
	StickerProvider,
	StickerSearchResult,
} from "../types";

const SHAPES_PROVIDER_ID = "shapes";

type ShapeGraphicPreset = {
	shapeKey: string;
	/** Used for element naming and query matching, not for display. */
	name: string;
	/** Localized display label, when one exists for this shape. */
	labelKey?: LocaleKey;
	definitionId: string;
	params?: ParamValues;
};

const LEGACY_SHAPE_PRESETS: Record<string, ShapeGraphicPreset> = {
	square: {
		shapeKey: "square",
		name: "Square",
		labelKey: "shapes.square",
		definitionId: "rectangle",
	},
	circle: {
		shapeKey: "circle",
		name: "Circle",
		labelKey: "shapes.circle",
		definitionId: "ellipse",
	},
	triangle: {
		shapeKey: "triangle",
		name: "Triangle",
		labelKey: "shapes.triangle",
		definitionId: "polygon",
		params: { sides: 3 },
	},
	hexagon: {
		shapeKey: "hexagon",
		name: "Hexagon",
		labelKey: "shapes.hexagon",
		definitionId: "polygon",
		params: { sides: 6 },
	},
	diamond: {
		shapeKey: "diamond",
		name: "Diamond",
		labelKey: "shapes.diamond",
		definitionId: "polygon",
		params: { sides: 4 },
	},
	star: {
		shapeKey: "star",
		name: "Star",
		labelKey: "shapes.star",
		definitionId: "star",
	},
};

/** Locale keys for the built-in graphic definitions, keyed by definition id. */
const SHAPE_LABEL_KEYS: Record<string, LocaleKey> = {
	rectangle: "graphics.rectangle",
	ellipse: "graphics.ellipse",
	polygon: "graphics.polygon",
	star: "graphics.star",
};

function getShapePresets(): ShapeGraphicPreset[] {
	registerDefaultGraphics();
	return graphicsRegistry.getAll().map((definition) => ({
		shapeKey: definition.id,
		name: definition.name,
		labelKey: SHAPE_LABEL_KEYS[definition.id],
		definitionId: definition.id,
	}));
}

function getShapePreset({
	shapeKey,
}: {
	shapeKey: string;
}): ShapeGraphicPreset | null {
	return (
		getShapePresets().find((preset) => preset.shapeKey === shapeKey) ??
		LEGACY_SHAPE_PRESETS[shapeKey] ??
		null
	);
}

function getShapeParams({
	preset,
}: {
	preset: ShapeGraphicPreset;
}): ParamValues {
	return {
		...buildDefaultGraphicInstance({ definitionId: preset.definitionId }).params,
		...preset.params,
	};
}

export function parseShapeStickerId({
	stickerId,
}: {
	stickerId: string;
}): ShapeGraphicPreset | null {
	try {
		const { providerValue } = parseStickerId({ stickerId });
		return getShapePreset({ shapeKey: providerValue });
	} catch {
		return null;
	}
}

function buildShapeUrl({ shapeKey }: { shapeKey: string }): string {
	const preset = getShapePreset({ shapeKey });
	if (!preset) {
		return buildGraphicPreviewUrl({ definitionId: "rectangle" });
	}
	return buildGraphicPreviewUrl({
		definitionId: preset.definitionId,
		params: getShapeParams({ preset }),
	});
}

function toStickerItem({
	preset,
}: {
	preset: ShapeGraphicPreset;
}): StickerItem {
	return {
		id: buildStickerId({
			providerId: SHAPES_PROVIDER_ID,
			providerValue: preset.shapeKey,
		}),
		provider: SHAPES_PROVIDER_ID,
		name: preset.name,
		labelKey: preset.labelKey,
		previewUrl: buildShapeUrl({ shapeKey: preset.shapeKey }),
		metadata: {
			definitionId: preset.definitionId,
			params: preset.params ?? {},
		},
	};
}

function filterShapesByQuery({ query }: { query: string }): ShapeGraphicPreset[] {
	const normalizedQuery = query.trim().toLowerCase();
	const presets = getShapePresets();
	if (!normalizedQuery) {
		return presets;
	}

	return presets.filter((preset) => {
		const definition = graphicsRegistry.get(preset.definitionId);
		return (
			preset.name.toLowerCase().includes(normalizedQuery) ||
			definition.keywords.some((keyword) =>
				keyword.toLowerCase().includes(normalizedQuery),
			)
		);
	});
}

function paginateShapes({
	shapes,
	options,
}: {
	shapes: ShapeGraphicPreset[];
	options?: { page?: number; limit?: number };
}): { items: ShapeGraphicPreset[]; hasMore: boolean; total: number } {
	const page = Math.max(1, options?.page ?? 1);
	const limit = Math.max(1, options?.limit ?? getShapePresets().length);
	const startIndex = (page - 1) * limit;
	const endIndex = startIndex + limit;
	const pagedItems = shapes.slice(startIndex, endIndex);
	return {
		items: pagedItems,
		hasMore: endIndex < shapes.length,
		total: shapes.length,
	};
}

export const shapesProvider: StickerProvider = {
	id: SHAPES_PROVIDER_ID,
	async search({
		query,
		options,
	}: {
		query: string;
		options?: { limit?: number };
	}): Promise<StickerSearchResult> {
		const filteredShapes = filterShapesByQuery({ query });
		const paged = paginateShapes({
			shapes: filteredShapes,
			options: { page: 1, limit: options?.limit ?? getShapePresets().length },
		});
		return {
			items: paged.items.map((preset) => toStickerItem({ preset })),
			total: paged.total,
			hasMore: paged.hasMore,
		};
	},
	async browse({
		options,
	}: {
		options?: { page?: number; limit?: number };
	}): Promise<StickerBrowseResult> {
		const paged = paginateShapes({
			shapes: getShapePresets(),
			options,
		});
		return {
			sections: [
				{
					id: "all",
					items: paged.items.map((preset) => toStickerItem({ preset })),
					hasMore: paged.hasMore,
					layout: "grid",
				},
			],
		};
	},
	resolveUrl({
		stickerId,
	}: {
		stickerId: string;
		options?: { width?: number; height?: number };
	}): string {
		const preset = parseShapeStickerId({ stickerId });
		return buildShapeUrl({ shapeKey: preset?.shapeKey ?? "rectangle" });
	},
};
