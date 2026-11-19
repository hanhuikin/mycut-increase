import { Button } from "@/components/ui/button";
import { useLocale } from "@/locale/locale-context";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useEditor } from "@/editor/use-editor";
import { TRANSCRIPTION_DIAGNOSTICS_SCOPE } from "@/transcription/diagnostics";
import { TRANSCRIPTION_LANGUAGES } from "@/transcription/supported-languages";
import type {
	CaptionChunk,
	TranscriptionLanguage,
	TranscriptionModelId,
} from "@/transcription/types";
import { insertCaptionChunksAsTextTrack } from "@/subtitles/insert";
import { parseSubtitleFile } from "@/subtitles/parse";
import { exportSrt, exportVtt } from "@/subtitles/export";
import { mediaTimeFromSeconds } from "@/wasm";
import { Spinner } from "@/components/ui/spinner";
import { useTranscriptionQueue } from "@/transcription/task-store";
import { transcriptionStepLabel } from "@/transcription/labels";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
} from "@/components/section";
import {
	AlertCircleIcon,
	CloudUploadIcon,
	Download02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { DiagnosticSeverity } from "@/diagnostics/types";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TRANSCRIPTION_MODELS } from "@/transcription/models";
import { toast } from "sonner";

const DIAGNOSTIC_BUTTON_VARIANT: Record<
	DiagnosticSeverity,
	"caution" | "destructive-foreground"
> = {
	caution: "caution",
	error: "destructive-foreground",
};

type ProcessingState =
	| {
			status: "idle";
			error: string | null;
			warnings: string[];
	  }
	| { status: "processing"; step: string };

type ProcessingAction =
	| { type: "start"; step: string }
	| { type: "update_step"; step: string }
	| { type: "succeed"; warnings: string[] }
	| { type: "fail"; error: string }
	| { type: "clear" };

const IDLE_STATE: ProcessingState = {
	status: "idle",
	error: null,
	warnings: [],
};

/* eslint-disable opencut/prefer-object-params -- React reducers must accept (state, action). */
function processingReducer(
	state: ProcessingState,
	action: ProcessingAction,
): ProcessingState {
	switch (action.type) {
		case "start":
			return { status: "processing", step: action.step };
		case "update_step":
			if (state.status !== "processing") return state;
			return { status: "processing", step: action.step };
		case "succeed":
			return {
				status: "idle",
				error: null,
				warnings: action.warnings,
			};
		case "fail":
			return { status: "idle", error: action.error, warnings: [] };
		case "clear":
			return { ...IDLE_STATE };
	}
}
/* eslint-enable opencut/prefer-object-params */

export function Captions() {
	const { t } = useLocale();
	const [selectedLanguage, setSelectedLanguage] =
		useState<TranscriptionLanguage>("auto");
	const [selectedModel, setSelectedModel] =
		useState<TranscriptionModelId>("whisper-small");
	const [processing, dispatch] = useReducer(processingReducer, IDLE_STATE);
	const containerRef = useRef<HTMLDivElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const editor = useEditor();

	// 转写任务在全局 store 里跑：面板卸载/切换标签后仍继续，任务抽屉同源展示。
	const transcriptionTasks = useTranscriptionQueue((state) => state.tasks);
	const startTranscription = useTranscriptionQueue((state) => state.start);
	const cancelTranscription = useTranscriptionQueue((state) => state.cancel);
	const activeProjectId = useEditor(
		(e) => e.project.getActiveOrNull()?.metadata.id ?? null,
	);
	const projectTasks = useMemo(
		() =>
			activeProjectId
				? transcriptionTasks.filter(
						(task) => task.projectId === activeProjectId,
					)
				: [],
		[transcriptionTasks, activeProjectId],
	);
	const activeTask =
		projectTasks.find((task) => task.status === "running") ?? null;
	const anyRunning = transcriptionTasks.some((task) => task.status === "running");
	const latestSucceeded =
		projectTasks.find(
			(task) => task.status === "succeeded" && task.captions.length > 0,
		) ?? null;

	// 预览列表的单一来源：最近一次转写成功 / 最近一次导入，谁后发生显示谁。
	const [captions, setCaptions] = useState<CaptionChunk[]>([]);
	const syncedTaskRef = useRef<string | null>(null);
	useEffect(() => {
		if (!latestSucceeded || latestSucceeded.id === syncedTaskRef.current) return;
		syncedTaskRef.current = latestSucceeded.id;
		setCaptions(latestSucceeded.captions);
	}, [latestSucceeded]);

	// 自动检测语言提示：只对刚完成不久的任务弹一次。
	const toastedLanguagesRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		for (const task of projectTasks) {
			if (
				task.status !== "succeeded" ||
				task.language !== "auto" ||
				!task.detectedLanguage ||
				toastedLanguagesRef.current.has(task.id)
			) {
				continue;
			}
			const finishedAt = task.finishedAt ? new Date(task.finishedAt).getTime() : 0;
			if (Date.now() - finishedAt > 60_000) {
				toastedLanguagesRef.current.add(task.id);
				continue;
			}
			toastedLanguagesRef.current.add(task.id);
			const matchedLabelKey = TRANSCRIPTION_LANGUAGES.find(
				(language) => language.code === task.detectedLanguage,
			)?.labelKey;
			toast.info(
				t["captions.detected_language"].replace(
					"{lang}",
					matchedLabelKey ? t[matchedLabelKey] : task.detectedLanguage,
				),
			);
		}
	}, [projectTasks, t]);

	const isProcessing = processing.status === "processing";
	const stepLabel = activeTask ? transcriptionStepLabel({ task: activeTask, t }) : null;

	const activeDiagnostics = useEditor((e) =>
		e.diagnostics.getActive({ scope: TRANSCRIPTION_DIAGNOSTICS_SCOPE }),
	);

	const insertCaptions = ({
		captions,
	}: {
		captions: CaptionChunk[];
	}): boolean => {
		const trackId = insertCaptionChunksAsTextTrack({ editor, captions });
		return trackId !== null;
	};

	const handleGenerateTranscript = () => {
		if (!activeProjectId || anyRunning) return;
		void startTranscription({
			editor,
			projectId: activeProjectId,
			language: selectedLanguage,
			modelId: selectedModel,
		});
	};

	const handleCancel = () => {
		cancelTranscription();
	};

	const handleImportClick = () => {
		fileInputRef.current?.click();
	};

	const handleImportFile = async ({ file }: { file: File }) => {
		dispatch({ type: "start", step: t["captions.reading_file"] });
		try {
			const input = await file.text();
			const result = parseSubtitleFile({
				fileName: file.name,
				input,
			});

			if (result.captions.length === 0) {
				dispatch({
					type: "fail",
					error: t["subtitles.no_valid_cues"],
				});
				return;
			}

			dispatch({ type: "update_step", step: t["captions.importing"] });

			if (!insertCaptions({ captions: result.captions })) {
				dispatch({ type: "fail", error: t["captions.no_captions_generated"] });
				return;
			}

			const nextWarnings = [...result.warnings];
			if (result.skippedCueCount > 0) {
				nextWarnings.unshift(
					t["captions.import_result"]
						.replace("{count}", String(result.captions.length))
						.replace("{skipped}", String(result.skippedCueCount)),
				);
			}

			dispatch({
				type: "succeed",
				warnings: nextWarnings,
			});
			setCaptions(result.captions);
		} catch (error) {
			console.error("Subtitle import failed:", error);
			dispatch({
				type: "fail",
				error:
					error instanceof Error
						? error.message
						: t["subtitles.unexpected_error"],
			});
		}
	};

	const handleFileChange = async ({
		event,
	}: {
		event: React.ChangeEvent<HTMLInputElement>;
	}) => {
		const file = event.target.files?.[0];
		if (event.target) {
			event.target.value = "";
		}
		if (!file) return;

		await handleImportFile({ file });
	};

	const handleLanguageChange = ({ value }: { value: string }) => {
		if (value === "auto") {
			setSelectedLanguage("auto");
			return;
		}

		const matchedLanguage = TRANSCRIPTION_LANGUAGES.find(
			(language) => language.code === value,
		);
		if (!matchedLanguage) return;
		setSelectedLanguage(matchedLanguage.code);
	};

	const handleModelChange = ({ value }: { value: string }) => {
		const matched = TRANSCRIPTION_MODELS.find((m) => m.id === value);
		if (matched) {
			setSelectedModel(matched.id);
		}
	};

	const handleExport = async (format: "srt" | "vtt") => {
		if (captions.length === 0) {
			toast.error(t["captions.no_captions"]);
			return;
		}
		const content =
			format === "srt"
				? exportSrt({ captions })
				: exportVtt({ captions });
		const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `subtitles.${format}`;
		a.click();
		URL.revokeObjectURL(url);
	};

	const handleClearCaptions = () => {
		dispatch({ type: "clear" });
		setCaptions([]);
		toast.success(t["captions.clear_all"]);
	};

	const handleJumpToTime = (time: number) => {
		editor.playback.seek({ time: mediaTimeFromSeconds({ seconds: time }) });
	};

	const formatTime = (seconds: number): string => {
		const m = Math.floor(seconds / 60);
		const s = Math.floor(seconds % 60);
		return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
	};

	const error = processing.status === "idle" ? processing.error : null;
	const warnings = processing.status === "idle" ? processing.warnings : [];

	return (
		<PanelView
			title={t["tab.captions"]}
			contentClassName="px-0 flex flex-col h-full"
			actions={
				<TooltipProvider>
					<div className="flex items-center gap-1.5">
						{!isProcessing &&
							activeDiagnostics.map((diagnostic) => (
								<Tooltip key={diagnostic.id}>
									<TooltipTrigger asChild>
										<Button
											variant={DIAGNOSTIC_BUTTON_VARIANT[diagnostic.severity]}
											size="icon"
											aria-label={diagnostic.message}
										>
											<HugeiconsIcon icon={AlertCircleIcon} size={16} />
										</Button>
									</TooltipTrigger>
									<TooltipContent>{diagnostic.message}</TooltipContent>
								</Tooltip>
							))}
						<Button
							type="button"
							variant="outline"
							size="sm"
							onClick={handleImportClick}
							disabled={isProcessing}
							className="items-center justify-center gap-1.5"
						>
							<HugeiconsIcon icon={CloudUploadIcon} />
							{t["captions.import"]}
						</Button>
						{captions.length > 0 && (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										type="button"
										variant="outline"
										size="sm"
										className="items-center justify-center gap-1.5"
									>
										<HugeiconsIcon icon={Download02Icon} />
										{t["captions.export"]}
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuItem onClick={() => handleExport("srt")}>
										{t["captions.export_srt"]}
									</DropdownMenuItem>
									<DropdownMenuItem onClick={() => handleExport("vtt")}>
										{t["captions.export_vtt"]}
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						)}
					</div>
				</TooltipProvider>
			}
			ref={containerRef}
		>
			<input
				ref={fileInputRef}
				type="file"
				accept=".srt,.ass"
				className="hidden"
				onChange={(event) => void handleFileChange({ event })}
			/>
			<Section
				showTopBorder={false}
				showBottomBorder={false}
				className="flex-1"
			>
				<SectionContent className="flex flex-col gap-4 h-full pt-1">
					<SectionFields>
						<SectionField label={t["captions.language"]}>
							<Select
								value={selectedLanguage}
								onValueChange={(value) => handleLanguageChange({ value })}
							>
								<SelectTrigger>
									<SelectValue placeholder={t["captions.language"]} />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="auto">
										{t["captions.auto_detect"]}
									</SelectItem>
									{TRANSCRIPTION_LANGUAGES.map((language) => (
										<SelectItem key={language.code} value={language.code}>
											{t[language.labelKey]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SectionField>

						<SectionField label={t["captions.model"]}>
							<Select
								value={selectedModel}
								onValueChange={(value) => handleModelChange({ value })}
							>
								<SelectTrigger>
									<SelectValue placeholder={t["captions.model"]} />
								</SelectTrigger>
								<SelectContent>
									{TRANSCRIPTION_MODELS.map((model) => (
										<SelectItem key={model.id} value={model.id}>
											{t[model.labelKey]}
										</SelectItem>
									))}
								</SelectContent>
							</Select>
						</SectionField>
					</SectionFields>

					<div className="flex gap-2">
						<Button
							type="button"
							className="flex-1"
							onClick={handleGenerateTranscript}
							disabled={
								isProcessing ||
								anyRunning ||
								activeDiagnostics.length > 0
							}
						>
							{(isProcessing || anyRunning) && <Spinner className="mr-1" />}
							{activeTask
								? stepLabel
								: isProcessing
									? processing.step
									: anyRunning
										? t["captions.transcribing"]
										: t["captions.generate"]}
						</Button>
						{activeTask && (
							<Button type="button" variant="outline" onClick={handleCancel}>
								{t["captions.cancel"]}
							</Button>
						)}
					</div>

					{/* 字幕预览列表 */}
					{captions.length > 0 && (
						<div className="flex flex-col gap-1 min-h-0">
							<div className="flex items-center justify-between">
								<span className="text-muted-foreground text-xs">
									{t["captions.transcribe"]}（{captions.length}）
								</span>
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={handleClearCaptions}
									className="h-6 text-xs text-muted-foreground hover:text-destructive"
								>
									{t["captions.clear_all"]}
								</Button>
							</div>
							<div className="scrollbar-hidden max-h-[200px] overflow-y-auto rounded-md border">
								{captions.map((caption, index) => (
									<button
										key={`${caption.startTime}-${index}`}
										type="button"
										className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-muted/50 transition-colors border-b last:border-b-0"
										onClick={() => handleJumpToTime(caption.startTime)}
									>
										<span className="text-muted-foreground w-6 shrink-0 tabular-nums">
											{index + 1}
										</span>
										<span className="text-muted-foreground w-12 shrink-0 tabular-nums">
											{formatTime(caption.startTime)}
										</span>
										<span className="truncate">
											{caption.text}
										</span>
									</button>
								))}
							</div>
						</div>
					)}

					{error && (
						<div className="bg-destructive/10 border-destructive/20 rounded-md border p-3">
							<p className="text-destructive text-sm">{error}</p>
						</div>
					)}
					{warnings.length > 0 && (
						<div className="rounded-md border border-amber-500/20 bg-amber-500/10 p-3">
							<ul className="space-y-1 text-sm text-amber-700">
								{warnings.map((warning) => (
									<li key={warning}>{warning}</li>
								))}
							</ul>
						</div>
					)}
				</SectionContent>
			</Section>
		</PanelView>
	);
}

