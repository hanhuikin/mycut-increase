"use client";

import { useCallback } from "react";
import { toast } from "sonner";
import { useLocale } from "@/locale/locale-context";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { useEditor } from "@/editor/use-editor";
import { buildTransitionElement } from "@/timeline/element-utils";
import {
	buildDefaultTransitionParams,
	transitionsRegistry,
} from "@/transitions";
import type { TransitionDefinition } from "@/transitions/types";
import {
	findCutNear,
	resolveTransitionWindow,
	type CutTracks,
} from "@/transitions/resolve";
import { roundMediaTime, TICKS_PER_SECOND } from "@/wasm";

/**
 * 转场面板：转场只能加在两个相邻片段的接缝上，所以点击时先把播放头吸附到
 * 最近的切点；附近没有切点就提示用户先切一刀 / 让两段首尾相接。
 */
export function TransitionsView() {
	const { t } = useLocale();
	const transitions = transitionsRegistry.getAll();

	return (
		<PanelView title={t["tab.transitions"]}>
			{transitions.length === 0 ? (
				<div className="flex flex-col gap-1 p-4">
					<p className="text-sm font-medium">{t["transitions.empty_title"]}</p>
					<p className="text-muted-foreground text-xs leading-relaxed">
						{t["transitions.empty_description"]}
					</p>
				</div>
			) : (
				<div
					className="grid gap-2"
					style={{
						gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))",
					}}
				>
					{transitions.map((transition) => (
						<TransitionItem key={transition.type} transition={transition} />
					))}
				</div>
			)}
		</PanelView>
	);
}

function TransitionItem({ transition }: { transition: TransitionDefinition }) {
	const { t } = useLocale();
	const editor = useEditor();
	const label = transition.labelKey ? t[transition.labelKey] : transition.name;

	const handleAddToTimeline = useCallback(() => {
		const sceneTracks = editor.scenes.getActiveScene().tracks;
		const lanes: CutTracks = {
			lanes: [
				{ elements: sceneTracks.main.elements },
				...sceneTracks.overlay
					.filter((track) => track.type === "video")
					.map((track) => ({ elements: track.elements })),
			],
		};
		const currentTime = editor.playback.getCurrentTime();
		const cut = findCutNear({ tracks: lanes, time: currentTime });
		if (!cut) {
			toast.error(t["transitions.no_cut_near"]);
			return;
		}

		const duration = roundMediaTime({
			time: transition.defaultDurationSeconds * TICKS_PER_SECOND,
		});
		const window = resolveTransitionWindow({
			transition: { duration },
			cut,
		});

		const element = buildTransitionElement({
			transitionType: transition.type,
			name: label,
			// resolve.ts 是纯函数（只用 number），这里换回 MediaTime
			startTime: roundMediaTime({ time: window.start }),
			duration: roundMediaTime({ time: window.duration }),
			cutTime: roundMediaTime({ time: cut.time }),
			params: buildDefaultTransitionParams({
				transitionType: transition.type,
			}),
		});

		editor.timeline.insertElement({
			placement: { mode: "auto", trackType: "transition" },
			element,
		});
		editor.playback.seek({ time: roundMediaTime({ time: cut.time }) });
		toast.success(t["transitions.inserted"]);
	}, [editor, transition, label, t]);

	return (
		<DraggableItem
			name={label}
			preview={
				<div className="bg-accent flex size-full items-center justify-center rounded">
					<span className="text-xs select-none">{label}</span>
				</div>
			}
			onAddToTimeline={handleAddToTimeline}
			isDraggable={false}
			aspectRatio={1}
			isRounded
			variant="card"
			containerClassName="w-full"
		/>
	);
}
