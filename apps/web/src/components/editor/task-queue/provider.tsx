"use client";

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { toast } from "sonner";
import { readVideoFile } from "@/media/mediabunny";
import { useEditor } from "@/editor/use-editor";
import { useLocale } from "@/locale/locale-context";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { mediaTimeFromSeconds } from "@/wasm";

/**
 * Global generation-task layer. Owns the poll loop against /api/ai/tasks and
 * everything that must survive leaving the AI panel: status, toasts, and the
 * auto-import of finished clips into the media library. The AI panel only
 * submits; it never holds a generation again.
 */

export interface GenerationTask {
	id: string;
	batchId: string | null;
	batchIndex: number | null;
	modelId: string;
	prompt: string;
	params: {
		mode?: string;
		duration?: number | "auto";
		resolution?: string;
		aspect?: string | null;
		audio?: boolean;
	};
	status: "submitting" | "queued" | "generating" | "succeeded" | "failed" | "canceled";
	videoUrl: string | null;
	errorSummary: string | null;
	errorDetails: Array<{ channel: string; message: string; at: string }>;
	pointsFrozen: number;
	pointsSettled: number | null;
	createdAt: string;
	startedAt: string | null;
	finishedAt: string | null;
}

const ACTIVE = new Set(["submitting", "queued", "generating"]);

interface TaskQueueState {
	tasks: GenerationTask[];
	activeCount: number;
	/** Submit one generation; resolves once the task is persisted. */
	submitVideo: (params: {
		modelId: string;
		prompt: string;
		duration?: number | "auto";
		resolution?: string;
		aspectRatio?: string;
		generateAudio?: boolean;
		imageUrl?: string;
		batchId?: string;
		batchIndex?: number;
	}) => Promise<string>;
	/** Insert every completed shot of a batch, in shot order. */
	insertBatchIntoTimeline: (batchId: string) => Promise<void>;
	/** task id → imported asset id (for manual timeline inserts). */
	importedAssets: Map<string, string>;
	deleteTask: (id: string) => Promise<void>;
	clearFinished: () => Promise<void>;
}

const TaskQueueContext = createContext<TaskQueueState | null>(null);

export function useTaskQueue(): TaskQueueState {
	const state = useContext(TaskQueueContext);
	if (!state) {
		throw new Error("useTaskQueue must be used within TaskQueueProvider");
	}
	return state;
}

function isGenerationTask(value: unknown): value is GenerationTask {
	if (!isRecord(value)) return false;
	return (
		typeof value.id === 'string' &&
		typeof value.modelId === 'string' &&
		typeof value.status === 'string'
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

export function TaskQueueProvider({ children }: { children: ReactNode }) {
	const editor = useEditor();
	const { t } = useLocale();
	const [tasks, setTasks] = useState<GenerationTask[]>([]);
	/** task id → imported media asset id. */
	const [importedAssets, setImportedAssets] = useState<Map<string, string>>(
		new Map(),
	);

	const activeProjectId = useEditor((e) => e.project.getActiveOrNull()?.metadata.id ?? null);

	const refresh = useCallback(async (): Promise<void> => {
		try {
			const res = await fetch("/api/ai/tasks");
			if (!res.ok) return;
			const raw: unknown = await res.json();
			if (!isRecord(raw) || !Array.isArray(raw.tasks)) return;
			setTasks(raw.tasks.filter(isGenerationTask));
		} catch {
			// Offline or rate-limited: keep the last known state, annotate later.
		}
	}, []);

	// Initial load + poll loop. Faster while the drawer is open, calm otherwise.
	useEffect(() => {
		const kickoff = setTimeout(() => void refresh(), 0);
		const interval = setInterval(
			() => void refresh(),
			5000,
		);
		return () => {
			clearTimeout(kickoff);
			clearInterval(interval);
		};
	}, [refresh]);

	const downloadTaskVideo = useCallback(
		async (task: GenerationTask): Promise<File | null> => {
			if (!task.videoUrl) return null;
			// Proxied server-side: the vendor URLs carry no CORS headers.
			const proxyUrl = `/api/media/download?url=${encodeURIComponent(task.videoUrl)}`;
			const response = await fetch(proxyUrl);
			if (!response.ok) return null;
			const blob = await response.blob();
			return new File([blob], `${task.id}.mp4`, { type: "video/mp4" });
		},
		[],
	);

	/** Import a finished clip into the media library; returns asset id + real duration. */
	const importToLibrary = useCallback(
		async (
			task: GenerationTask,
			name: string,
		): Promise<{ assetId: string | null; durationSeconds: number | null }> => {
			const projectId = activeProjectId;
			if (!projectId) return { assetId: null, durationSeconds: null };
			const file = await downloadTaskVideo(task);
			if (!file) return { assetId: null, durationSeconds: null };
			let thumbnailUrl: string | undefined;
			let videoDuration: number | undefined;
			let width: number | undefined;
			let height: number | undefined;
			try {
				const videoData = await readVideoFile({ file });
				thumbnailUrl = videoData.thumbnailUrl ?? undefined;
				videoDuration = videoData.duration;
				width = videoData.width;
				height = videoData.height;
			} catch {
				// A placeholder thumbnail still beats losing the clip.
			}
			const asset = await editor.media.addMediaAsset({
				projectId,
				asset: {
					name,
					file,
					type: "video",
					url: URL.createObjectURL(file),
					thumbnailUrl,
					duration: videoDuration,
					width,
					height,
				},
			});
			return { assetId: asset?.id ?? null, durationSeconds: videoDuration ?? null };
		},
		[activeProjectId, downloadTaskVideo, editor.media],
	);

	// React to status transitions: auto-import finished clips, toast failures.
	const seenStatus = useRef<Map<string, string>>(new Map());
	const importing = useRef<Set<string>>(new Set());
	const queueImport = useCallback((task: GenerationTask) => {
		if (importing.current.has(task.id)) return;
		importing.current.add(task.id);
		const name = `${t["ai_video.asset_name"]}-${task.createdAt.slice(11, 19).replace(/:/g, "")}`;
		void importToLibrary(task, name)
			.then(({ assetId, durationSeconds }) => {
				if (!assetId) return;
				setImportedAssets((prev) => new Map(prev).set(task.id, assetId));
				// Single generations keep the old behaviour: land on the
				// timeline at once. Batch shots wait for an explicit insert.
				if (!task.batchId) {
					const seconds =
						durationSeconds ??
						(typeof task.params.duration === "number"
							? task.params.duration
							: 5);
					editor.timeline.insertElement({
						element: buildElementFromMedia({
							mediaId: assetId,
							mediaType: "video",
							name,
							duration: mediaTimeFromSeconds({ seconds }),
							startTime: mediaTimeFromSeconds({ seconds: 0 }),
						}),
						placement: { mode: "auto", trackType: "video" },
					});
				}
				toast.success(t["task_queue.toast_done"]);
			})
			.catch(() => {
				toast.error(t["task_queue.toast_import_failed"]);
			})
			.finally(() => importing.current.delete(task.id));
	}, [importToLibrary, editor.timeline, t]);
	useEffect(() => {
		for (const task of tasks) {
			const previous = seenStatus.current.get(task.id);
			seenStatus.current.set(task.id, task.status);
			if (previous === task.status) continue;
			if (previous === undefined) {
				// First sight. A task that finished while nobody was watching
				// (panel closed, page reloaded) still lands in the library when
				// it finished recently; old records are history, not news.
				if (task.status === 'succeeded' && !importedAssets.has(task.id)) {
					const age = Date.now() - new Date(task.finishedAt ?? task.createdAt).getTime();
					if (age < 10 * 60 * 1000) queueImport(task);
				}
				continue;
			}
			if (previous !== "succeeded" && task.status === "succeeded") {
				queueImport(task);
			}
			if (previous !== "failed" && task.status === "failed") {
				toast.error(
					`${t["task_queue.toast_failed"]}: ${task.errorSummary ?? ""}`,
				);
			}
		}
	}, [tasks, queueImport, importedAssets, t]);

	const submitVideo = useCallback(
		async (params: {
			modelId: string;
			prompt: string;
			duration?: number | "auto";
			resolution?: string;
			aspectRatio?: string;
			generateAudio?: boolean;
			imageUrl?: string;
			batchId?: string;
			batchIndex?: number;
		}): Promise<string> => {
			const response = await fetch("/api/ai/generate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(params),
			});
			const raw: unknown = await response.json();
			const body = isRecord(raw)
				? {
						taskId:
							typeof raw.taskId === 'string' ? raw.taskId : undefined,
						error: typeof raw.error === 'string' ? raw.error : undefined,
						details: Array.isArray(raw.details)
							? raw.details.filter(
									(entry): entry is string =>
										typeof entry === 'string',
								)
							: undefined,
						cost: typeof raw.cost === 'number' ? raw.cost : undefined,
						balance:
							typeof raw.balance === 'number' ? raw.balance : undefined,
					}
				: {};
			if (!response.ok || !body.taskId) {
				const message =
					(body.details && body.details[0]) ||
					body.error ||
					`请求失败 (${response.status})`;
				const error = new Error(message) as Error & {
					code?: string;
					cost?: number;
					balance?: number;
				};
				error.code = body.error;
				error.cost = body.cost;
				error.balance = body.balance;
				throw error;
			}
			// The list picks the row up on its next tick; nudge now so the
			// drawer shows it immediately.
			void refresh();
			return body.taskId;
		},
		[refresh],
	);

	const insertBatchIntoTimeline = useCallback(
		async (batchId: string): Promise<void> => {
			const shots = tasks
				.filter(
					(task) =>
						task.batchId === batchId &&
						task.status === "succeeded" &&
						importedAssets.has(task.id),
				)
				.sort((a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0));
			let startSeconds = 0;
			for (const shot of shots) {
				const assetId = importedAssets.get(shot.id);
				if (!assetId) continue;
				const seconds = 5; // real duration lives on the asset; placement is auto
				editor.timeline.insertElement({
					element: buildElementFromMedia({
						mediaId: assetId,
						mediaType: "video",
						name: `${t["ai_video.shot_asset_name"].replace("{index}", String((shot.batchIndex ?? 0) + 1))}`,
						duration: mediaTimeFromSeconds({
							seconds: typeof shot.params.duration === "number"
								? shot.params.duration
								: seconds,
						}),
						startTime: mediaTimeFromSeconds({ seconds: startSeconds }),
					}),
					placement: { mode: "auto", trackType: "video" },
				});
				startSeconds +=
					typeof shot.params.duration === "number" ? shot.params.duration : 5;
			}
		},
		[editor.timeline, t, tasks, importedAssets],
	);

	const deleteTask = useCallback(
		async (id: string): Promise<void> => {
			await fetch(`/api/ai/tasks/${id}`, { method: "DELETE" });
			setTasks((prev) => prev.filter((task) => task.id !== id));
			setImportedAssets((prev) => {
				const next = new Map(prev);
				next.delete(id);
				return next;
			});
		},
		[],
	);

	const clearFinished = useCallback(async (): Promise<void> => {
		await fetch("/api/ai/tasks", { method: "DELETE" });
		setTasks((prev) => prev.filter((task) => ACTIVE.has(task.status)));
	}, []);

	const activeCount = useMemo(
		() => tasks.filter((task) => ACTIVE.has(task.status)).length,
		[tasks],
	);

	const state: TaskQueueState = {
		tasks,
		activeCount,
		submitVideo,
		insertBatchIntoTimeline,
		importedAssets,
		deleteTask,
		clearFinished,
	};

	return (
		<TaskQueueContext.Provider value={state}>
			{children}
		</TaskQueueContext.Provider>
	);
}
