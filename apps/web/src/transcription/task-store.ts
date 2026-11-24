"use client";

import { create } from "zustand";
import type { EditorCore } from "@/core";
import { extractTimelineAudioSamples } from "@/media/mediabunny";
import { transcriptionService } from "@/services/transcription/service";
import { insertCaptionChunksAsTextTrack } from "@/subtitles/insert";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/transcription/audio";
import { buildCaptionChunks } from "@/transcription/caption";
import type {
	CaptionChunk,
	TranscriptionLanguage,
	TranscriptionModelId,
} from "@/transcription/types";

/**
 * 字幕转写的全局任务状态。
 *
 * 转写原先由字幕面板组件自己持有——切到别的面板组件卸载，进度和结果就
 * 看不见了。这里把「提取音频 → 加载模型 → 转写 → 插入字幕」整体搬进模块级
 * store：面板只负责发起和展示，任务抽屉可以从同一份状态里列出进度/取消/
 * 结果，切换面板甚至切换项目再回来也不会丢。
 *
 * 仍受浏览器限制：Web Worker 随页面卸载而销毁，刷新后运行中的任务不会续跑
 * （本 store 不落盘，刷新后清空）。
 */

export type TranscriptionTaskStatus =
	| "running"
	| "succeeded"
	| "failed"
	| "canceled";

export type TranscriptionStage =
	| "extracting_audio"
	| "preparing_audio"
	| "loading_model"
	| "transcribing"
	| "generating_captions";

export interface TranscriptionTask {
	id: string;
	projectId: string;
	/** 发起时选择的语言（"auto" 表示自动检测）。 */
	language: TranscriptionLanguage;
	modelId: TranscriptionModelId;
	status: TranscriptionTaskStatus;
	stage: TranscriptionStage | null;
	/** 0–100；无进度概念的阶段为 null。 */
	progress: number | null;
	captions: CaptionChunk[];
	/** 是否已插入时间轴（切换项目完成时为 false，可手动补插）。 */
	inserted: boolean;
	/** Whisper 检测到的语言代码（请求 auto 时有意义）。 */
	detectedLanguage: string | null;
	/** 失败原因；"no_captions" 走本地化文案。 */
	error: string | null;
	errorCode: "no_captions" | null;
	createdAt: string;
	finishedAt: string | null;
}

interface ActiveRun {
	id: string;
	/** cancel() 后置位：后续阶段的更新与插入全部忽略。 */
	aborted: boolean;
}

let activeRun: ActiveRun | null = null;

interface TranscriptionQueueState {
	tasks: TranscriptionTask[];
	/** 发起一次转写；已有任务在跑时返回 null（Web Worker 只能串行）。 */
	start: (args: {
		editor: EditorCore;
		projectId: string;
		language: TranscriptionLanguage;
		modelId: TranscriptionModelId;
	}) => Promise<string | null>;
	cancel: () => void;
	removeTask: (id: string) => void;
	clearFinished: (projectId: string) => void;
	/** 把已完成任务的字幕补插到当前项目时间轴。 */
	insertTask: (args: { id: string; editor: EditorCore }) => boolean;
}

const nowIso = (): string => new Date().toISOString();

const newTaskId = (): string =>
	typeof crypto !== "undefined" && "randomUUID" in crypto
		? crypto.randomUUID()
		: `tr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

export const useTranscriptionQueue = create<TranscriptionQueueState>(
	(set, get) => ({
		tasks: [],

		start: async ({ editor, projectId, language, modelId }) => {
			if (activeRun) return null;

			const id = newTaskId();
			const run: ActiveRun = { id, aborted: false };
			activeRun = run;

			set((state) => ({
				tasks: [
					{
						id,
						projectId,
						language,
						modelId,
						status: "running",
						stage: "extracting_audio",
						progress: null,
						captions: [],
						inserted: false,
						detectedLanguage: null,
						error: null,
						errorCode: null,
						createdAt: nowIso(),
						finishedAt: null,
					},
					...state.tasks,
				],
			}));

			const update = (patch: Partial<TranscriptionTask>): void => {
				if (run.aborted) return;
				set((state) => ({
					tasks: state.tasks.map((task) =>
						task.id === id ? { ...task, ...patch } : task,
					),
				}));
			};

			try {
				// 转写只需要 16kHz 单声道：直接按目标格式提取并取回浮点 samples。
				// 不走 WAV blob → decodeAudioData 的往返——长内容下那段解码是
				// 无进度黑盒且内存峰值数倍于 samples 本身，曾表现为「准备音频中」
				// 永远转圈。onElementProgress 让长时间轴的提取阶段有真实进度。
				const { samples } = await extractTimelineAudioSamples({
					tracks: editor.scenes.getActiveScene().tracks,
					mediaAssets: editor.media.getAssets(),
					totalDuration: editor.timeline.getTotalDuration(),
					sampleRate: DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
					channels: 1,
					onProgress: (progress) => {
						update({ stage: "extracting_audio", progress });
					},
					onElementProgress: (completed, total) => {
						update({
							stage: "extracting_audio",
							progress: 10 + (80 * completed) / Math.max(1, total),
						});
					},
				});
				if (run.aborted) return null;

				const result = await transcriptionService.transcribe({
					audioData: samples,
					language: language === "auto" ? undefined : language,
					modelId,
					sampleRate: DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
					onProgress: (progress) => {
						if (progress.status === "loading-model") {
							update({ stage: "loading_model", progress: progress.progress });
						} else if (progress.status === "transcribing") {
							update({ stage: "transcribing", progress: progress.progress });
						}
					},
				});
				if (run.aborted) return null;

				update({ stage: "generating_captions", progress: null });
				const captions = buildCaptionChunks({ segments: result.segments });
				if (captions.length === 0) {
					update({
						status: "failed",
						stage: null,
						errorCode: "no_captions",
						finishedAt: nowIso(),
					});
					return null;
				}

				// 只有仍在发起项目时才自动插入；切到别的项目后保留结果，由用户
				// 在任务抽屉里手动补插，避免把字幕写进错误的时间轴。
				const activeProjectId =
					editor.project.getActiveOrNull()?.metadata.id ?? null;
				const inserted =
					activeProjectId === projectId &&
					insertCaptionChunksAsTextTrack({ editor, captions }) !== null;

				update({
					status: "succeeded",
					stage: null,
					progress: null,
					captions,
					inserted,
					detectedLanguage:
						result.language && result.language !== "auto"
							? result.language
							: null,
					finishedAt: nowIso(),
				});
			} catch (error) {
				if (
					run.aborted ||
					(error instanceof Error &&
						error.message === "Transcription cancelled")
				) {
					return null;
				}
				update({
					status: "failed",
					stage: null,
					error: error instanceof Error ? error.message : "transcription_failed",
					finishedAt: nowIso(),
				});
			} finally {
				if (activeRun === run) activeRun = null;
			}

			return id;
		},

		cancel: () => {
			const run = activeRun;
			if (!run) return;
			run.aborted = true;
			activeRun = null;
			transcriptionService.cancel();
			set((state) => ({
				tasks: state.tasks.map((task) =>
					task.id === run.id
						? {
								...task,
								status: "canceled",
								stage: null,
								progress: null,
								finishedAt: nowIso(),
							}
						: task,
				),
			}));
		},

		removeTask: (id) =>
			set((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) })),

		clearFinished: (projectId) =>
			set((state) => ({
				tasks: state.tasks.filter(
					(task) =>
						task.projectId !== projectId || task.status === "running",
				),
			})),

		insertTask: ({ id, editor }) => {
			const task = get().tasks.find((item) => item.id === id);
			if (!task || task.captions.length === 0 || task.inserted) return false;
			const activeProjectId =
				editor.project.getActiveOrNull()?.metadata.id ?? null;
			if (activeProjectId !== task.projectId) return false;
			const inserted =
				insertCaptionChunksAsTextTrack({ editor, captions: task.captions }) !==
				null;
			if (inserted) {
				set((state) => ({
					tasks: state.tasks.map((item) =>
						item.id === id ? { ...item, inserted: true } : item,
					),
				}));
			}
			return inserted;
		},
	}),
);
