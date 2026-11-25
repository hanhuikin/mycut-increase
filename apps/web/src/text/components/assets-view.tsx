import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { useLocale } from "@/locale/locale-context";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useEditor } from "@/editor/use-editor";
import { DEFAULTS } from "@/timeline/defaults";
import { buildTextElement } from "@/timeline/element-utils";
import type { MediaTime } from "@/wasm";

export function TextView() {
	const { t } = useLocale();
	const editor = useEditor();

	const handleAddToTimeline = ({ currentTime }: { currentTime: MediaTime }) => {
		const activeScene = editor.scenes.getActiveScene();
		if (!activeScene) return;

		// 用面板上显示的那段文案作为初始内容：卡片写「默认文字」，插进去却是
		// 英文 "Default text" 会让人以为写入没生效。
		const element = buildTextElement({
			raw: {
				...DEFAULTS.text.element,
				params: {
					...DEFAULTS.text.element.params,
					content: t["text.default_text"],
				},
			},
			startTime: currentTime,
		});

		editor.timeline.insertElement({
			element,
			placement: { mode: "auto" },
		});
	};

	return (
		<PanelView title={t["tab.text"]}>
			<DraggableItem
				name={t["text.default_text"]}
				preview={
					<div className="bg-accent flex size-full items-center justify-center rounded">
						<span className="text-xs select-none">
							{t["text.default_text"]}
						</span>
					</div>
				}
				dragData={{
					id: "temp-text-id",
					type: DEFAULTS.text.element.type,
					name: DEFAULTS.text.element.name,
					content: t["text.default_text"],
				}}
				aspectRatio={1}
				onAddToTimeline={handleAddToTimeline}
				shouldShowLabel={false}
			/>
		</PanelView>
	);
}
