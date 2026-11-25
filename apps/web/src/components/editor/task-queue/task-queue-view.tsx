"use client";

import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { cn } from "@/utils/ui";
import { useLocale } from "@/locale/locale-context";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { useBilling } from "@/services/billing/client";
import { useEditor } from "@/editor/use-editor";
import {
	useTranscriptionQueue,
	type TranscriptionTask,
} from "@/transcription/task-store";
import {
	transcriptionLanguageLabel,
	transcriptionModelLabel,
	transcriptionStepLabel,
} from "@/transcription/labels";
import { type GenerationTask, useTaskQueue } from "./provider";

/**
 * 方案 D：任务作为素材面板的一等公民（独立标签页）。列表 + 详情两段，
 * 数据与动作全部来自 TaskQueueProvider——提交方在 AI 视频面板，这里只负责
 * 状态展示、历史回查与完成后的手动操作。
 */

const ACTIVE = new Set(["submitting", "queued", "generating"]);

/** 本地时区的完整时间戳：YYYY-MM-DD HH:mm:ss（任务提交时刻）。 */
function formatDateTime(iso: string): string {
	const date = new Date(iso);
	const p = (n: number) => String(n).padStart(2, "0");
	return (
		`${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ` +
		`${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
	);
}

function StatusPill({ status, label }: { status: string; label: string }) {
	const isActive = ACTIVE.has(status) || status === "running";
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px]",
				status === "succeeded" && "text-emerald-500 bg-emerald-500/10",
				status === "failed" && "text-red-500 bg-red-500/10",
				isActive && "text-primary bg-primary/10",
				status === "canceled" && "text-muted-foreground bg-muted",
			)}
		>
			{isActive && (
				<span className="size-1.5 animate-pulse rounded-full bg-current" />
			)}
			{label}
		</span>
	);
}

function TimelineStep({
	tone,
	label,
}: {
	tone: "done" | "running" | "error" | "idle";
	label: ReactNode;
}) {
	return (
		<div className="text-muted-foreground flex items-center gap-2">
			<span
				className={cn(
					"size-1.5 rounded-full",
					tone === "error" && "bg-red-500",
					tone === "running" && "animate-pulse bg-primary",
					tone === "done" && "bg-emerald-500",
					tone === "idle" && "bg-border",
				)}
			/>
			<span className={cn(tone === "error" && "text-red-500")}>{label}</span>
		</div>
	);
}

export function TaskQueueView() {
	const { t } = useLocale();
	const billing = useBilling();
	const modelLabel = (id: string): string =>
		billing.models.get(id)?.label ?? id;
	const {
		tasks,
		deleteTask,
		clearFinished,
		importedAssets,
		importTask,
		insertBatchIntoTimeline,
	} = useTaskQueue();
	const editor = useEditor();
	const activeProjectId = useEditor(
		(e) => e.project.getActiveOrNull()?.metadata.id ?? null,
	);
	const transcriptionTasks = useTranscriptionQueue((state) => state.tasks);
	const cancelTranscription = useTranscriptionQueue((state) => state.cancel);
	const removeTranscription = useTranscriptionQueue(
		(state) => state.removeTask,
	);
	const clearTranscriptionFinished = useTranscriptionQueue(
		(state) => state.clearFinished,
	);
	const insertTranscription = useTranscriptionQueue(
		(state) => state.insertTask,
	);
	const [detailId, setDetailId] = useState<string | null>(null);

	// 本地转写任务按当前项目过滤：字幕只属于发起它的那个项目。
	const localTasks = activeProjectId
		? transcriptionTasks.filter((task) => task.projectId === activeProjectId)
		: [];
	const activeLocalTasks = localTasks.filter(
		(task) => task.status === "running",
	);
	const finishedLocalTasks = localTasks.filter(
		(task) => task.status !== "running",
	);

	const statusLabels: Record<string, string> = {
		submitting: t["task_queue.status_submitting"],
		queued: t["task_queue.status_queued"],
		generating: t["task_queue.status_generating"],
		succeeded: t["task_queue.status_succeeded"],
		failed: t["task_queue.status_failed"],
		canceled: t["task_queue.status_canceled"],
		running: t["task_queue.status_transcribing"],
	};

	const active = tasks.filter((task) => ACTIVE.has(task.status));
	const finished = tasks.filter((task) => !ACTIVE.has(task.status));
	const detail = tasks.find((task) => task.id === detailId) ?? null;

	// Storyboard shots collapse into one batch card; singles render flat.
	const batches = new Map<string, GenerationTask[]>();
	const singles: GenerationTask[] = [];
	for (const task of tasks) {
		if (task.batchId) {
			const list = batches.get(task.batchId) ?? [];
			list.push(task);
			batches.set(task.batchId, list);
		} else {
			singles.push(task);
		}
	}

	const doneShots = (batchId: string): number =>
		tasks.filter(
			(shot) =>
				shot.batchId === batchId &&
				shot.status === "succeeded" &&
				importedAssets.has(shot.id),
		).length;

	const activeSingleCards = singles
		.filter((task) => ACTIVE.has(task.status))
		.map((task) => <TaskCard key={task.id} task={task} onOpen={setDetailId} />);
	const activeBatchCards = [...batches.entries()]
		.filter(([, shots]) => shots.some((shot) => ACTIVE.has(shot.status)))
		.map(([batchId, shots]) => (
			<BatchCard
				key={batchId}
				batchId={batchId}
				shots={shots}
				onOpen={setDetailId}
			/>
		));
	const finishedSingleCards = singles
		.filter((task) => !ACTIVE.has(task.status))
		.map((task) => <TaskCard key={task.id} task={task} onOpen={setDetailId} />);
	const finishedBatchCards = [...batches.entries()]
		.filter(([, shots]) => !shots.some((shot) => ACTIVE.has(shot.status)))
		.map(([batchId, shots]) => (
			<BatchCard
				key={batchId}
				batchId={batchId}
				shots={shots}
				onOpen={setDetailId}
			/>
		));

	return (
		<PanelView
			title={t["task_queue.title"]}
			actions={
				finished.length + finishedLocalTasks.length > 0 ? (
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground rounded px-1.5 py-1 text-xs"
						onClick={() => {
							void clearFinished();
							if (activeProjectId) {
								clearTranscriptionFinished(activeProjectId);
							}
						}}
					>
						{t["task_queue.clear"]}
					</button>
				) : undefined
			}
		>
			{tasks.length === 0 && localTasks.length === 0 && (
				<div className="text-muted-foreground py-16 text-center text-xs">
					{t["task_queue.empty"]}
				</div>
			)}

			{active.length + activeLocalTasks.length > 0 && (
				<>
					<div className="text-muted-foreground px-1 pt-1 pb-1.5 text-[11px]">
						{t["task_queue.group_active"]} ·{" "}
						{active.length + activeLocalTasks.length}
					</div>
					{activeLocalTasks.map((task) => (
						<TranscriptionCard key={task.id} task={task} />
					))}
					{activeSingleCards}
					{activeBatchCards}
				</>
			)}

			{finished.length + finishedLocalTasks.length > 0 && (
				<>
					<div className="text-muted-foreground px-1 pt-3 pb-1.5 text-[11px]">
						{t["task_queue.group_earlier"]}
					</div>
					{finishedLocalTasks.map((task) => (
						<TranscriptionCard key={task.id} task={task} />
					))}
					{finishedSingleCards}
					{finishedBatchCards}
				</>
			)}

			{detail && <TaskDetail task={detail} onClose={() => setDetailId(null)} />}
		</PanelView>
	);

	function TranscriptionCard({ task }: { task: TranscriptionTask }) {
		const running = task.status === "running";
		const progress =
			task.progress != null ? Math.min(100, Math.max(2, task.progress)) : null;
		return (
			<div className="bg-accent/40 mb-1.5 rounded-lg border border-transparent p-2.5">
				<div className="flex items-center justify-between gap-2">
					<span className="truncate text-xs font-semibold">
						{t["task_queue.kind_transcription"]}
					</span>
					<StatusPill
						status={task.status}
						label={statusLabels[task.status] ?? task.status}
					/>
				</div>
				<div className="text-muted-foreground mt-1 truncate text-xs">
					{transcriptionModelLabel({ modelId: task.modelId, t })} ·{" "}
					{transcriptionLanguageLabel({ language: task.language, t })}
					{task.usedCpuFallback && <> · {t["captions.device_cpu"]}</>}
				</div>
				{running && (
					<>
						<div className="text-muted-foreground mt-1 text-[11px]">
							{transcriptionStepLabel({ task, t })}
						</div>
						<div className="bg-border mt-2 h-1 overflow-hidden rounded-full">
							{progress != null ? (
								<div
									className="bg-primary/80 h-full transition-[width]"
									style={{ width: `${progress}%` }}
								/>
							) : (
								<div className="bg-primary/60 h-full w-1/3 animate-pulse" />
							)}
						</div>
					</>
				)}
				{task.status === "failed" && (
					<div className="mt-1 text-[11px] text-red-500">
						{task.errorCode === "no_captions"
							? t["captions.no_captions_generated"]
							: (task.error ?? t["task_queue.toast_transcription_failed"])}
					</div>
				)}
				{task.status === "succeeded" && (
					<div className="text-muted-foreground mt-1 text-[11px]">
						{t["task_queue.transcription_captions"].replace(
							"{n}",
							String(task.captions.length),
						)}
						{task.inserted && ` · ${t["task_queue.inserted"]}`}
					</div>
				)}
				<div className="text-muted-foreground mt-1 flex items-center justify-between text-[11px]">
					<span>{formatDateTime(task.createdAt)}</span>
					<div className="flex items-center gap-2">
						{running && (
							<button
								type="button"
								className="hover:text-foreground"
								onClick={cancelTranscription}
							>
								{t["captions.cancel"]}
							</button>
						)}
						{task.status === "succeeded" && !task.inserted && (
							<button
								type="button"
								className="hover:text-foreground"
								onClick={() => {
									if (!insertTranscription({ id: task.id, editor })) {
										toast.error(t["task_queue.insert_captions_failed"]);
									}
								}}
							>
								{t["task_queue.insert_captions"]}
							</button>
						)}
						{!running && (
							<button
								type="button"
								className="hover:text-foreground"
								onClick={() => removeTranscription(task.id)}
							>
								{t["task_queue.delete"]}
							</button>
						)}
					</div>
				</div>
			</div>
		);
	}

	function TaskCard({
		task,
		onOpen,
	}: {
		task: GenerationTask;
		onOpen: (id: string) => void;
	}) {
		return (
			<div
				className="bg-accent/40 hover:border-border hover:bg-accent/60 mb-1.5 cursor-pointer rounded-lg border border-transparent p-2.5"
				onClick={() => onOpen(task.id)}
				onKeyDown={(event) => {
					if (event.key === "Enter") onOpen(task.id);
				}}
				role="button"
				tabIndex={0}
			>
				<div className="flex items-center justify-between gap-2">
					<span className="truncate text-xs font-semibold">
						{modelLabel(task.modelId)}
					</span>
					<StatusPill
						status={task.status}
						label={statusLabels[task.status] ?? task.status}
					/>
				</div>
				{task.prompt && (
					<div className="text-muted-foreground mt-1 truncate text-xs">
						{task.prompt}
					</div>
				)}
				{ACTIVE.has(task.status) && (
					<div className="bg-border mt-2 h-1 overflow-hidden rounded-full">
						{task.status === "queued" ? (
							<div className="bg-primary/60 h-full w-1/3 animate-pulse" />
						) : (
							<div className="bg-primary/80 h-full w-2/3 animate-pulse" />
						)}
					</div>
				)}
				<div className="text-muted-foreground mt-1.5 flex items-center justify-between text-[11px]">
					<span>
						{task.params.resolution} · {task.params.aspect ?? "16:9"} ·{" "}
						{typeof task.params.duration === "number"
							? `${task.params.duration}s`
							: "auto"}
					</span>
					{task.status === "succeeded" && importedAssets.has(task.id) && (
						<span>{t["task_queue.in_library"]}</span>
					)}
				</div>
				<div className="text-muted-foreground mt-1 text-[11px]">
					{formatDateTime(task.createdAt)}
				</div>
			</div>
		);
	}

	function BatchCard({
		batchId,
		shots,
		onOpen,
	}: {
		batchId: string;
		shots: GenerationTask[];
		onOpen: (id: string) => void;
	}) {
		const ordered = [...shots].sort(
			(a, b) => (a.batchIndex ?? 0) - (b.batchIndex ?? 0),
		);
		const done = shots.filter((shot) => shot.status === "succeeded").length;
		const anyActive = shots.some((shot) => ACTIVE.has(shot.status));
		return (
			<div
				className="bg-accent/40 hover:border-border hover:bg-accent/60 mb-1.5 cursor-pointer rounded-lg border border-transparent p-2.5"
				onClick={() => onOpen(ordered[0]?.id ?? batchId)}
				onKeyDown={(event) => {
					if (event.key === "Enter") onOpen(ordered[0]?.id ?? batchId);
				}}
				role="button"
				tabIndex={0}
			>
				<div className="flex items-center justify-between gap-2">
					<span className="truncate text-xs font-semibold">
						{t["task_queue.title"]} · {shots.length}
					</span>
					<span
						className={cn(
							"rounded-full px-2 py-0.5 text-[11px]",
							anyActive
								? "text-primary bg-primary/10"
								: done === shots.length
									? "text-emerald-500 bg-emerald-500/10"
									: "text-red-500 bg-red-500/10",
						)}
					>
						{t["task_queue.batch_progress"]
							.replace("{done}", String(done))
							.replace("{total}", String(shots.length))}
					</span>
				</div>
				<div className="mt-2 flex gap-1">
					{ordered.map((shot) => (
						<div
							key={shot.id}
							className={cn(
								"flex h-7 flex-1 items-center justify-center rounded-md text-[11px]",
								shot.status === "succeeded" &&
									"text-emerald-500 bg-emerald-500/10",
								ACTIVE.has(shot.status) &&
									"text-primary animate-pulse bg-primary/10",
								shot.status === "failed" && "text-red-500 bg-red-500/10",
								shot.status !== "succeeded" &&
									!ACTIVE.has(shot.status) &&
									shot.status !== "failed" &&
									"bg-muted text-muted-foreground",
							)}
						>
							{(shot.batchIndex ?? 0) + 1}
						</div>
					))}
				</div>
				<div className="text-muted-foreground mt-1 text-[11px]">
					{formatDateTime(
						shots
							.map((shot) => shot.createdAt)
							.reduce((a, b) => (a < b ? a : b), shots[0].createdAt),
					)}
				</div>
			</div>
		);
	}

	function TaskDetail({
		task,
		onClose,
	}: {
		task: GenerationTask;
		onClose: () => void;
	}) {
		const isBatch = Boolean(task.batchId);
		const batchImportable =
			isBatch && task.batchId && doneShots(task.batchId) > 0;
		const [importingId, setImportingId] = useState<string | null>(null);
		return (
			<div className="bg-background absolute inset-0 z-10 flex flex-col">
				<div className="flex h-11 shrink-0 items-center justify-between border-b px-3">
					<span className="text-sm font-medium">{t["task_queue.detail"]}</span>
					<button
						type="button"
						aria-label={t["common.close"]}
						className="text-muted-foreground hover:text-foreground rounded p-1"
						onClick={onClose}
					>
						{t["common.close"]}
					</button>
				</div>
				<div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 text-xs">
					{task.status === "succeeded" && task.videoUrl && (
						// eslint-disable-next-line jsx-a11y/media-has-caption -- raw generated clip has no captions
						<video
							className="mb-3 aspect-video w-full rounded-lg border"
							src={task.videoUrl}
							controls
						/>
					)}

					<div className="text-muted-foreground mb-1.5 text-[11px]">
						{t["task_queue.params"]}
					</div>
					<div className="grid grid-cols-[86px_1fr] gap-x-3 gap-y-1">
						<span className="text-muted-foreground">
							{t["task_queue.model"]}
						</span>
						<span>{modelLabel(task.modelId)}</span>
						<span className="text-muted-foreground">
							{t["task_queue.mode"]}
						</span>
						<span>
							{task.params.mode === "image-to-video"
								? t["task_queue.mode_i2v"]
								: t["task_queue.mode_t2v"]}
						</span>
						<span className="text-muted-foreground">
							{t["task_queue.duration_resolution"]}
						</span>
						<span>
							{typeof task.params.duration === "number"
								? `${task.params.duration}s`
								: "auto"}{" "}
							· {task.params.resolution} · {task.params.aspect ?? "16:9"}
						</span>
						<span className="text-muted-foreground">
							{t["task_queue.submitted_at"]}
						</span>
						<span>{formatDateTime(task.createdAt)}</span>
						{task.pointsSettled != null && (
							<>
								<span className="text-muted-foreground">
									{t["task_queue.points_settled"]}
								</span>
								<span>{task.pointsSettled} 点</span>
							</>
						)}
						{task.status === "failed" && task.pointsFrozen > 0 && (
							<>
								<span className="text-muted-foreground">
									{t["task_queue.points_refunded"]}
								</span>
								<span>{task.pointsFrozen} 点</span>
							</>
						)}
					</div>

					{task.prompt && (
						<div className="mt-3">
							<div className="text-muted-foreground mb-1.5 text-[11px]">
								{t["task_queue.params"]} · 描述
							</div>
							<div className="bg-accent/40 rounded-md p-2 leading-relaxed">
								{task.prompt}
							</div>
						</div>
					)}

					<div className="mt-3">
						<div className="text-muted-foreground mb-1.5 text-[11px]">
							{t["task_queue.timeline"]}
						</div>
						<div className="space-y-1.5">
							<TimelineStep
								tone="done"
								label={`${t["task_queue.submitted_at"]} · ${formatDateTime(task.createdAt)}`}
							/>
							{ACTIVE.has(task.status) && (
								<TimelineStep
									tone="running"
									label={
										task.status === "generating"
											? t["task_queue.status_generating"]
											: task.status === "queued"
												? t["task_queue.status_queued"]
												: t["task_queue.status_submitting"]
									}
								/>
							)}
							{task.status === "succeeded" && (
								<TimelineStep
									tone="done"
									label={t["task_queue.status_succeeded"]}
								/>
							)}
							{task.status === "failed" && (
								<TimelineStep
									tone="error"
									label={`${t["task_queue.status_failed"]}: ${task.errorSummary ?? ""}`}
								/>
							)}
						</div>
					</div>

					{task.errorDetails && task.errorDetails.length > 0 && (
						<div className="mt-3">
							<div className="text-muted-foreground mb-1.5 text-[11px]">
								{t["task_queue.channel_attempts"]}
							</div>
							<div className="space-y-1">
								{task.errorDetails.map((entry, index) => (
									<div
										key={`${entry.at}-${index}`}
										className="text-muted-foreground rounded-md bg-accent/40 px-2 py-1.5 text-[11px]"
									>
										<span className="text-foreground">{entry.channel}</span>{" "}
										{entry.message}
									</div>
								))}
							</div>
						</div>
					)}

					<div className="mt-4 flex flex-wrap gap-2 pb-2">
						{task.status === "succeeded" &&
							!isBatch &&
							(importedAssets.has(task.id) ? (
								<span className="text-muted-foreground bg-muted rounded-md px-2 py-1.5 text-[11px]">
									{t["task_queue.in_library"]}
								</span>
							) : (
								<button
									type="button"
									disabled={importingId === task.id}
									className="bg-primary text-primary-foreground rounded-md px-2.5 py-1.5 text-[11px] font-medium disabled:opacity-60"
									onClick={() => {
										setImportingId(task.id);
										void importTask(task).finally(() => setImportingId(null));
									}}
								>
									{importingId === task.id
										? t["task_queue.importing"]
										: t["task_queue.import_to_library"]}
								</button>
							))}
						{batchImportable && (
							<button
								type="button"
								className="bg-primary text-primary-foreground rounded-md px-2.5 py-1.5 text-[11px] font-medium"
								onClick={() => {
									if (typeof task.batchId !== "string") return;
									void insertBatchIntoTimeline(task.batchId);
								}}
							>
								{t["task_queue.insert_batch"]}
							</button>
						)}
						{!ACTIVE.has(task.status) && (
							<button
								type="button"
								className="text-muted-foreground hover:text-foreground rounded-md border px-2.5 py-1.5 text-[11px]"
								onClick={() => {
									void deleteTask(task.id).then(onClose);
								}}
							>
								{t["task_queue.delete"]}
							</button>
						)}
					</div>
				</div>
			</div>
		);
	}
}
