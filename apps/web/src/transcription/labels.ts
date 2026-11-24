import type { LocaleStrings } from "@/locale";
import { TRANSCRIPTION_MODELS } from "@/transcription/models";
import { TRANSCRIPTION_LANGUAGES } from "@/transcription/supported-languages";
import type { TranscriptionTask } from "@/transcription/task-store";

/** 转写阶段 → 本地化步骤文案（字幕面板与任务队列共用）。 */
export function transcriptionStepLabel({
	task,
	t,
}: {
	task: TranscriptionTask;
	t: LocaleStrings;
}): string {
	switch (task.stage) {
		case "extracting_audio":
			return appendProgress({
				label: t["captions.extracting_audio"],
				progress: task.progress,
			});
		case "preparing_audio":
			return t["captions.preparing_audio"];
		case "loading_model":
			return t["captions.loading_model"].replace(
				"{progress}",
				String(Math.round(task.progress ?? 0)),
			);
		case "transcribing":
			return appendProgress({
				label: t["captions.transcribing"],
				progress: task.progress,
			});
		case "generating_captions":
			return t["captions.generating_captions"];
		default:
			return t["captions.transcribing"];
	}
}

function appendProgress({
	label,
	progress,
}: {
	label: string;
	progress: number | null;
}): string {
	return progress != null ? `${label} ${Math.round(progress)}%` : label;
}

export function transcriptionModelLabel({
	modelId,
	t,
}: {
	modelId: TranscriptionTask["modelId"];
	t: LocaleStrings;
}): string {
	const model = TRANSCRIPTION_MODELS.find((entry) => entry.id === modelId);
	return model ? t[model.labelKey] : modelId;
}

export function transcriptionLanguageLabel({
	language,
	t,
}: {
	language: TranscriptionTask["language"];
	t: LocaleStrings;
}): string {
	if (language === "auto") return t["captions.auto_detect"];
	const matched = TRANSCRIPTION_LANGUAGES.find(
		(entry) => entry.code === language,
	);
	return matched ? t[matched.labelKey] : language;
}
