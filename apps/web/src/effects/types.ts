import type { LocaleKey } from "@/locale";
import type { ParamValues } from "@/params";
import type { LocalizedParamDefinition } from "@/graphics/types";

export interface Effect {
	id: string;
	type: string;
	params: ParamValues;
	enabled: boolean;
}

export type EffectUniformValue = number | number[];

export interface EffectPass {
	shader: string;
	uniforms: Record<string, EffectUniformValue>;
}

export interface EffectPassTemplate {
	shader: string;
	uniforms(params: {
		effectParams: ParamValues;
		width: number;
		height: number;
	}): Record<string, EffectUniformValue>;
}

export interface EffectRendererConfig {
	passes: EffectPassTemplate[];
	buildPasses?: (params: {
		effectParams: ParamValues;
		width: number;
		height: number;
	}) => EffectPass[];
}

export interface EffectDefinition {
	type: string;
	/** Used for search matching and persisted element names; keep stable. Display uses `labelKey`. */
	name: string;
	/** Translation key for the display label. */
	labelKey?: LocaleKey;
	keywords: string[];
	params: LocalizedParamDefinition[];
	renderer: EffectRendererConfig;
}
