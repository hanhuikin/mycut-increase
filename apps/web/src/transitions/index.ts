import { buildDefaultParamValues } from "@/params/registry";
import type { ParamValues } from "@/params";
import { defaultTransitions } from "./definitions";
import { transitionsRegistry } from "./registry";

export { transitionsRegistry } from "./registry";
import type { TransitionDefinition } from "./types";

export type {
	ResolvedTransition,
	TransitionDefinition,
	TransitionDirection,
	TransitionFamily,
} from "./types";

export function registerDefaultTransitions(): void {
	for (const definition of defaultTransitions) {
		if (transitionsRegistry.has(definition.type)) {
			continue;
		}
		transitionsRegistry.register({
			key: definition.type,
			definition,
		});
	}
}

/** 预设的默认参数值；未知预设返回空对象（渲染期会退化成淡入淡出）。 */
export function buildDefaultTransitionParams({
	transitionType,
}: {
	transitionType: string;
}): ParamValues {
	if (!transitionsRegistry.has(transitionType)) {
		return {};
	}
	return buildDefaultParamValues(
		transitionsRegistry.get(transitionType).params,
	);
}

export function getTransitionDefinitionOrNull({
	transitionType,
}: {
	transitionType: string;
}): TransitionDefinition | null {
	return transitionsRegistry.has(transitionType)
		? transitionsRegistry.get(transitionType)
		: null;
}
