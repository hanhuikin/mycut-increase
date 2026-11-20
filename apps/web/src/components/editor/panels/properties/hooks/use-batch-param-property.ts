"use client";

import { useEditor } from "@/editor/use-editor";
import { writeElementParamValue, type ElementParamDefinition } from "@/params/registry";
import type { TimelineElement } from "@/timeline";

export interface BatchParamTarget {
	trackId: string;
	element: TimelineElement;
}

/**
 * 批量（多选）参数编辑：onPreview 把同一个值写进所有 target 的 params
 * （各元素自己的其他 params 不动），一次 previewElements；onCommit 统一
 * commitPreview 生成一条 undo 历史。批量模式不做 keyframe 编辑——单条的
 * 动画通道仍由 useKeyframedParamProperty 处理。
 */
export function useBatchParamProperty({
	param,
	targets,
}: {
	param: ElementParamDefinition;
	targets: BatchParamTarget[];
}): {
	onPreview: (value: number | string | boolean) => void;
	onCommit: () => void;
} {
	const editor = useEditor();

	const onPreview = (value: number | string | boolean) => {
		editor.timeline.previewElements({
			updates: targets.map(({ trackId, element }) => ({
				trackId,
				elementId: element.id,
				updates: writeElementParamValue({ element, param, value }),
			})),
		});
	};

	return {
		onPreview,
		onCommit: () => editor.timeline.commitPreview(),
	};
}
