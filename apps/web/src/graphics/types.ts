import type { LocaleKey, LocaleStrings } from "@/locale";
import type { ParamDefinition, ParamValues } from "@/params";

/**
 * A param definition carrying optional translation keys for its labels.
 * `label` stays as the untranslated fallback so the shared param renderer
 * keeps working; consumers that have a dictionary resolve `labelKey` first.
 */
export type LocalizedParamDefinition<TKey extends string = string> =
	ParamDefinition<TKey> & {
		labelKey?: LocaleKey;
		/** Translation keys for select option labels, keyed by option value. */
		optionLabelKeys?: Record<string, LocaleKey>;
	};

/** Resolves a localized param definition into one the shared renderer can use. */
export function localizeParamDefinition({
	param,
	t,
}: {
	param: LocalizedParamDefinition;
	t: LocaleStrings;
}): ParamDefinition {
	const label = param.labelKey ? t[param.labelKey] : param.label;

	if (param.type === "select") {
		return {
			...param,
			label,
			options: param.options.map((option) => {
				const optionLabelKey = param.optionLabelKeys?.[option.value];
				return optionLabelKey
					? { ...option, label: t[optionLabelKey] }
					: option;
			}),
		};
	}

	return { ...param, label };
}

export const DEFAULT_GRAPHIC_SOURCE_SIZE = 512;

export interface GraphicRenderContext {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	params: ParamValues;
	width: number;
	height: number;
}

export interface GraphicDefinition {
	id: string;
	/** Used for search matching; keep stable. Display uses `labelKey` when available. */
	name: string;
	/** Translation key for the display label. */
	labelKey?: LocaleKey;
	keywords: string[];
	params: LocalizedParamDefinition[];
	render(context: GraphicRenderContext): void;
}

export interface GraphicInstance {
	definitionId: string;
	params: ParamValues;
}
