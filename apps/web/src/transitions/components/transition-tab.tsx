"use client";

import type { TransitionElement } from "@/timeline";
import { getTransitionDefinitionOrNull } from "@/transitions";
import { localizeParamDefinition } from "@/graphics/types";
import { useLocale } from "@/locale/locale-context";
import { useElementPreview } from "@/timeline/hooks/use-element-preview";
import {
	Section,
	SectionContent,
	SectionFields,
	SectionTitle,
} from "@/components/section";
import { PropertyParamField } from "@/components/editor/panels/properties/components/property-param-field";
import { roundMediaTime, TICKS_PER_SECOND } from "@/wasm";

/**
 * 转场属性面板：预设自带参数（方向 / 羽化 / 强度）+ 时长。
 * 与独立特效一致，参数改动走 previewElements，失焦/松手才 commit 成一条撤销。
 */
export function TransitionTab({
	element,
	trackId,
}: {
	element: TransitionElement;
	trackId: string;
}) {
	const { t } = useLocale();
	const { renderElement, previewUpdates, commit } = useElementPreview({
		trackId,
		elementId: element.id,
		fallback: element,
	});

	const definition = getTransitionDefinitionOrNull({
		transitionType: element.transitionType,
	});
	const params = definition
		? definition.params.map((param) => localizeParamDefinition({ param, t }))
		: [];

	const previewParam = (key: string) => (value: number | string | boolean) => {
		previewUpdates({
			params: { ...renderElement.params, [key]: value },
		});
	};

	const durationSeconds = renderElement.duration / TICKS_PER_SECOND;

	return (
		<div className="flex h-full flex-col">
			<div className="flex h-11 shrink-0 items-center border-b px-3.5">
				<SectionTitle>
					{definition
						? t[definition.labelKey ?? "properties.transition"]
						: t["properties.transition"]}
				</SectionTitle>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<Section sectionKey={`transition:${element.id}`}>
					<SectionContent className="pt-4">
						<SectionFields>
							<label className="flex flex-col gap-1.5">
								<span className="text-muted-foreground text-xs">
									{t["prop.duration_seconds"]}
								</span>
								<input
									type="number"
									min={0.1}
									step={0.1}
									className="border-input bg-accent h-9 w-full rounded-md border px-3 text-sm outline-none"
									defaultValue={Number(durationSeconds.toFixed(2))}
									onBlur={(event) => {
										const next = Number(event.currentTarget.value);
										if (!Number.isFinite(next) || next <= 0) return;
										previewUpdates({
											duration: roundMediaTime({
												time: next * TICKS_PER_SECOND,
											}),
										});
										commit();
									}}
								/>
							</label>
							{params.map((param) => (
								<PropertyParamField
									key={param.key}
									param={param}
									value={renderElement.params[param.key] ?? param.default}
									onPreview={previewParam(param.key)}
									onCommit={commit}
								/>
							))}
						</SectionFields>
					</SectionContent>
				</Section>
			</div>
		</div>
	);
}
