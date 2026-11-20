"use client";

import { resolveAnimationPathValueAtTime } from "@/animation";
import { Section, SectionContent, SectionFields } from "@/components/section";
import { useElementPlayhead } from "@/components/editor/panels/properties/hooks/use-element-playhead";
import { useKeyframedParamProperty } from "@/components/editor/panels/properties/hooks/use-keyframed-param-property";
import {
	useBatchParamProperty,
	type BatchParamTarget,
} from "@/components/editor/panels/properties/hooks/use-batch-param-property";
import { PropertyParamField } from "@/components/editor/panels/properties/components/property-param-field";
import type { ParamValue, ParamValues } from "@/params";
import {
	getElementParams,
	readElementParamValue,
	writeElementParamValue,
	type ElementParamDefinition,
} from "@/params/registry";
import type { TimelineElement } from "@/timeline";
import type { MediaTime } from "@/wasm";

export function ElementParamsTab({
	element,
	trackId,
	paramKeys,
	sectionKey,
	targets,
}: {
	element: TimelineElement;
	trackId: string;
	paramKeys?: readonly string[];
	sectionKey: string;
	/** 提供且长度 > 1 时进入批量模式：控件值取 targets[0]，改动应用到全部。 */
	targets?: BatchParamTarget[];
}) {
	const isBatch = (targets?.length ?? 0) > 1;
	const { localTime, isPlayheadWithinElementRange } = useElementPlayhead({
		startTime: element.startTime,
		duration: element.duration,
	});
	const params = getElementParams({ element }).filter(
		(param) => !paramKeys || paramKeys.includes(param.key),
	);
	// 批量模式下内容是每条字幕自己的文本，绝不批量覆盖。
	const batchParams = isBatch
		? params.filter((param) => param.key !== "content")
		: params;
	const baseValues = buildValues({ element, params });

	return (
		<Section sectionKey={isBatch ? `batch:${sectionKey}` : `${element.id}:${sectionKey}`}>
			<SectionContent className="pt-4">
				<SectionFields>
					{batchParams
						.filter((param) => isVisible({ param, values: baseValues }))
						.map((param) =>
							isBatch && targets ? (
								<BatchElementParamField
									key={param.key}
									param={param}
									targets={targets}
									baseValue={baseValues[param.key] ?? param.default}
								/>
							) : (
								<ElementParamField
									key={param.key}
									element={element}
									trackId={trackId}
									param={param}
									baseValue={baseValues[param.key] ?? param.default}
									localTime={localTime}
									isPlayheadWithinElementRange={isPlayheadWithinElementRange}
								/>
							),
						)}
				</SectionFields>
			</SectionContent>
		</Section>
	);
}

function ElementParamField({
	element,
	trackId,
	param,
	baseValue,
	localTime,
	isPlayheadWithinElementRange,
}: {
	element: TimelineElement;
	trackId: string;
	param: ElementParamDefinition;
	baseValue: ParamValue;
	localTime: MediaTime;
	isPlayheadWithinElementRange: boolean;
}) {
	const resolvedValue = resolveAnimationPathValueAtTime({
		animations: element.animations,
		propertyPath: param.key,
		localTime,
		fallbackValue: baseValue,
	});
	const animatedParam = useKeyframedParamProperty({
		param,
		trackId,
		elementId: element.id,
		animations: element.animations,
		propertyPath: param.key,
		localTime,
		isPlayheadWithinElementRange,
		resolvedValue,
		buildBaseUpdates: ({ value }) =>
			writeElementParamValue({ element, param, value }),
	});

	return (
		<PropertyParamField
			param={param}
			value={resolvedValue}
			onPreview={animatedParam.onPreview}
			onCommit={animatedParam.onCommit}
			keyframe={
				param.keyframable === false
					? undefined
					: {
							isActive: animatedParam.isKeyframedAtTime,
							isDisabled: !isPlayheadWithinElementRange,
							onToggle: animatedParam.toggleKeyframe,
						}
			}
		/>
	);
}

/** 批量模式字段：值取 targets[0]，不解析动画通道，不提供 keyframe 操作。 */
function BatchElementParamField({
	param,
	targets,
	baseValue,
}: {
	param: ElementParamDefinition;
	targets: BatchParamTarget[];
	baseValue: ParamValue;
}) {
	const batchParam = useBatchParamProperty({ param, targets });

	return (
		<PropertyParamField
			param={param}
			value={baseValue}
			onPreview={batchParam.onPreview}
			onCommit={batchParam.onCommit}
		/>
	);
}

function buildValues({
	element,
	params,
}: {
	element: TimelineElement;
	params: readonly ElementParamDefinition[];
}): ParamValues {
	const values: ParamValues = {};
	for (const param of params) {
		const value = readElementParamValue({ element, param });
		if (value !== null) {
			values[param.key] = value;
		}
	}
	return values;
}

function isVisible({
	param,
	values,
}: {
	param: ElementParamDefinition;
	values: ParamValues;
}): boolean {
	return (param.dependencies ?? []).every((dependency) =>
		areParamValuesEqual({
			left: values[dependency.param],
			right: dependency.equals,
		}),
	);
}

function areParamValuesEqual({
	left,
	right,
}: {
	left: ParamValue | undefined;
	right: ParamValue;
}): boolean {
	return left === right;
}
