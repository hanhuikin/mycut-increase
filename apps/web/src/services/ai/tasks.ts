import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import postgres from "postgres";
import { db } from "@/db";
import { webEnv } from "@/env/web";
import {
	type TGenerationTask,
	generationTasks,
} from "@/db/schema";
import {
	familyForKind,
	getChannel,
	getChannelCredential,
	resolveChannelChain,
} from "@/services/admin/channels";
import {
	estimateModelCost,
	getModel,
} from "@/services/admin/models";
import { getProtocol } from "@/services/ai/protocols";
import {
	freezeForTask,
	refundTask,
	settleTask,
} from "@/services/billing/ledger";

/**
 * Server-side owner of a generation task's life: submit → poll → settle /
 * refund, with channel fallback. The browser only sees rows through
 * `GET /api/ai/tasks`, whose reads sync active tasks in place ("lazy sync") —
 * no worker, no client-held poll loop, so status survives panel switches and
 * page reloads.
 */

/** Giving up on a task this long after submission releases its freeze. */
const TASK_TIMEOUT_MS = 30 * 60 * 1000;
/** Channel fallback attempts per task, mirroring the old client-side bound. */
const MAX_ATTEMPTS = 25;

export interface TaskSubmitParams {
	prompt: string;
	duration: number | "auto";
	resolution: "480p" | "720p" | "1080p" | undefined;
	aspectRatio: string | undefined;
	generateAudio: boolean;
	/** Start frame as a data: URL. In-memory only — never persisted. */
	imageUrl?: string;
}

export type AttemptResult =
	| {
			ok: true;
			channelId: string;
			protocolId: string;
			upstreamJobId: string;
			refId: string;
			frozen: number;
	  }
	| {
			ok: false;
			error: string;
			attemptErrors: Array<{
				channel: string;
				message: string;
				at: string;
			}>;
	  };

type AttemptErrors = Array<{ channel: string; message: string; at: string }>;

/**
 * One billable attempt: freeze the estimate, walk the channel chain in
 * priority order, return the first channel that accepts. Refusals before the
 * freeze come back as !ok with their reason; a freeze that happened is
 * released when every channel refuses, so an attempt never leaves points on
 * the floor.
 */
export async function submitAttempt({
	userId,
	model,
	params,
	exclude,
	cost,
}: {
	userId: string;
	model: NonNullable<Awaited<ReturnType<typeof getModel>>>;
	params: TaskSubmitParams;
	exclude: string[];
	cost: number;
}): Promise<AttemptResult> {
	const attemptErrors: AttemptErrors = [];
	const chain = await resolveChannelChain({
		modelId: model.id,
		kind: model.kind,
		imageUrl: params.imageUrl,
	});
	const candidates = chain.filter(
		(routed) => !exclude.includes(routed.channel.id),
	);

	if (candidates.length === 0) {
		return {
			ok: false,
			error: "没有可用渠道：请检查渠道是否启用并配置密钥",
			attemptErrors,
		};
	}

	const refId = crypto.randomUUID();
	if (cost > 0) {
		try {
			await freezeForTask({
				userId,
				refId,
				amount: cost,
				note: `${model.label} ${params.resolution ?? "720p"} ${params.duration === "auto" ? 5 : params.duration}s`,
				modelId: model.id,
				seconds:
					params.duration === "auto"
						? null
						: Math.min(
								Math.max(Math.round(params.duration), 1),
								model.maxDuration,
							),
			});
		} catch (error) {
			if (error instanceof Error && error.message === "insufficient balance") {
				return { ok: false, error: "余额不足", attemptErrors };
			}
			throw error;
		}
	}

	for (const routed of candidates) {
		try {
			const submitted = await routed.protocol.submit({
				model: routed.upstreamModel,
				family: "video",
				apiKey: routed.apiKey,
				baseUrl: routed.baseUrl,
				prompt: params.prompt,
				duration: params.duration,
				resolution: params.resolution,
				aspectRatio: params.aspectRatio,
				generateAudio: params.generateAudio,
				imageUrl: params.imageUrl,
			});
			return {
				ok: true,
				channelId: routed.channel.id,
				protocolId: routed.protocol.id,
				upstreamJobId: submitted.jobId,
				refId,
				frozen: cost,
			};
		} catch (error) {
			attemptErrors.push({
				channel: routed.channel.name,
				message: error instanceof Error ? error.message : "未知错误",
				at: new Date().toISOString(),
			});
		}
	}

	// No channel accepted it: the freeze for this attempt goes back.
	if (cost > 0) {
		try {
			await refundTask({
				userId,
				refId,
				note: attemptErrors[0]?.message ?? "submit failed",
				modelId: model.id,
			});
		} catch (error) {
			console.error("submit refund failed:", error);
		}
	}
	return {
		ok: false,
		error: attemptErrors[0]?.message ?? "所有渠道提交失败",
		attemptErrors,
	};
}

/** Create the persisted row once an attempt has been accepted upstream. */
export async function createTask({
	userId,
	modelId,
	prompt,
	params,
	batchId,
	batchIndex,
	attempt,
}: {
	userId: string;
	modelId: string;
	prompt: string;
	params: TaskSubmitParams;
	batchId: string | null;
	batchIndex: number | null;
	attempt: Extract<AttemptResult, { ok: true }>;
}): Promise<string> {
	const id = crypto.randomUUID();
	await db.insert(generationTasks).values({
		id,
		userId,
		batchId,
		batchIndex,
		modelId,
		prompt: prompt.slice(0, 2000),
		params: {
			mode: params.imageUrl ? "image-to-video" : "text-to-video",
			duration: params.duration,
			resolution: params.resolution ?? "720p",
			aspect: params.aspectRatio ?? null,
			audio: params.generateAudio,
		},
		status: "queued",
		channelId: attempt.channelId,
		protocol: attempt.protocolId,
		upstreamJobId: attempt.upstreamJobId,
		refId: attempt.refId,
		hasStartImage: Boolean(params.imageUrl),
		pointsFrozen: attempt.frozen,
	});
	return id;
}

const TERMINAL = ["succeeded", "failed", "canceled"] as const;
const ACTIVE = ["submitting", "queued", "generating"] as const;

/** Narrow the stored resolution string to what the billing estimate takes. */
function taskResolution(value: string): "480p" | "720p" | "1080p" {
	return value === "480p" || value === "1080p" ? value : "720p";
}

function isTerminal(status: string): boolean {
	return (TERMINAL as readonly string[]).includes(status);
}

/** Settle what the finished clip actually costs, mirroring the settle route. */
async function settleAttempt({
	userId,
	task,
	model,
}: {
	userId: string;
	task: TGenerationTask;
	model: NonNullable<Awaited<ReturnType<typeof getModel>>>;
}): Promise<number> {
	const actualSeconds = Math.min(
		Math.max(
			Math.round(
				typeof task.params.duration === "number" ? task.params.duration : 5,
			),
			1,
		),
		15,
	);
	const points = estimateModelCost({
		model,
		resolution:
			taskResolution(task.params.resolution),
		seconds: actualSeconds,
	});
	await settleTask({
		userId,
		refId: task.refId ?? "",
		actual: points,
		note: `${model.label} ${actualSeconds}s`,
		modelId: model.id,
	});
	return points;
}

async function markSucceeded({
	task,
	videoUrl,
	points,
}: {
	task: TGenerationTask;
	videoUrl: string;
	points: number | null;
}): Promise<TGenerationTask> {
	const [updated] = await db
		.update(generationTasks)
		.set({
			status: "succeeded",
			videoUrl,
			pointsSettled: points,
			finishedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(generationTasks.id, task.id))
		.returning();
	return updated ?? task;
}

async function markFailed({
	userId,
	task,
	summary,
	details,
}: {
	userId: string;
	task: TGenerationTask;
	summary: string;
	details: AttemptErrors;
}): Promise<TGenerationTask> {
	// A no-op when the last attempt already released its freeze.
	if (task.refId) {
		try {
			await refundTask({
				userId,
				refId: task.refId,
				note: summary,
				modelId: task.modelId,
			});
		} catch (error) {
			console.error("fail refund failed:", error);
		}
	}
	const [updated] = await db
		.update(generationTasks)
		.set({
			status: "failed",
			errorSummary: summary,
			errorDetails: details,
			finishedAt: new Date(),
			updatedAt: new Date(),
		})
		.where(eq(generationTasks.id, task.id))
		.returning();
	return updated ?? task;
}

/**
 * Bring one active task up to date against its upstream: poll, settle or
 * refund, and fall back to the next channel when the current attempt dies.
 * Cheap enough to run inline on every list read.
 *
 * Guarded by a session advisory lock on the task id so multiple pods can run
 * this concurrently: the first pod to grab the lock syncs, the others return
 * the row as-is and catch up on a later read. Session locks release on
 * connection close, so a pod dying mid-sync cannot wedge the task.
 */
export async function syncTask({
	userId,
	task: taskRow,
}: {
	userId: string;
	task: TGenerationTask;
}): Promise<TGenerationTask> {
	// A clip that landed while its settle failed would keep the freeze on the
	// books forever — the task is terminal, so nothing else retries it. Settle
	// is idempotent per refId, so re-running it here on every read is safe.
	if (
		taskRow.status === "succeeded" &&
		taskRow.pointsSettled === null &&
		taskRow.refId
	) {
		const release = await tryTaskLock(taskRow.id);
		if (!release) return taskRow;
		try {
			return await retryHangingSettle({ userId, task: taskRow });
		} finally {
			await release();
		}
	}

	if (isTerminal(taskRow.status)) return taskRow;

	const release = await tryTaskLock(taskRow.id);
	// Busy — another replica is syncing right now; it will persist the result.
	if (!release) return taskRow;
	try {
		return await syncTaskLocked({ userId, task: taskRow });
	} finally {
		await release();
	}
}

/**
 * Reserved-session pool for advisory locks. Sessions must be stable for the
 * lock's lifetime (acquire and release on the same session), but a pool is
 * fine — each reserve hands out its own session. Sized above one so a slow
 * upstream poll holding a lock cannot stall every other task's sync.
 */
let lockSql: ReturnType<typeof postgres> | null = null;
const LOCK_POOL_MAX = 4;
function getLockClient(): ReturnType<typeof postgres> {
	if (!lockSql) {
		lockSql = postgres(webEnv.DATABASE_URL, {
			max: LOCK_POOL_MAX,
			idle_timeout: 30,
		});
	}
	return lockSql;
}

/**
 * Try to take the per-task advisory lock. Returns an unlock function on the
 * SAME reserved session, or null when another session holds it.
 */
async function tryTaskLock(
	taskId: string,
): Promise<(() => Promise<void>) | null> {
	const sql = getLockClient();
	const session = await sql.reserve();
	try {
		const rows = await session`select pg_try_advisory_lock(hashtext(${taskId})) as ok`;
		if (!rows[0]?.ok) {
			await session.release();
			return null;
		}
		let released = false;
		return async () => {
			if (released) return;
			released = true;
			try {
				await session`select pg_advisory_unlock(hashtext(${taskId}))`;
			} finally {
				await session.release();
			}
		};
	} catch (error) {
		await session.release();
		throw error;
	}
}

/**
 * Re-settle a succeeded clip whose settle never landed, then record the
 * settled points. Both halves are replay-safe: the ledger books once per
 * refId, and the row update is guarded on pointsSettled still being null.
 */
async function retryHangingSettle({
	userId,
	task,
}: {
	userId: string;
	task: TGenerationTask;
}): Promise<TGenerationTask> {
	const model = await getModel({ id: task.modelId });
	if (!model) return task;
	try {
		const points = await settleAttempt({ userId, task, model });
		const [updated] = await db
			.update(generationTasks)
			.set({ pointsSettled: points, updatedAt: new Date() })
			.where(
				and(
					eq(generationTasks.id, task.id),
					isNull(generationTasks.pointsSettled),
				),
			)
			.returning();
		return updated ?? task;
	} catch (error) {
		console.error("settle retry failed:", error);
		return task;
	}
}

async function syncTaskLocked({
	userId,
	task,
}: {
	userId: string;
	task: TGenerationTask;
}): Promise<TGenerationTask> {
	if (isTerminal(task.status)) return task;

	// Hard ceiling: an active task older than the budget releases its freeze
	// and stops — the same contract the old client-side timeout had, minus
	// the leaked freeze.
	if (Date.now() - new Date(task.createdAt).getTime() > TASK_TIMEOUT_MS) {
		const summary = task.refId
			? await refundTask({
					userId,
					refId: task.refId,
					note: "生成超时，已退回点数",
					modelId: task.modelId,
				}).then(
					() => "生成超时，已退回点数",
					() => "生成超时",
				)
			: "生成超时";
		return await markFailed({
			userId,
			task,
			summary,
			details: [
				...(task.errorDetails ?? []),
				{
					channel: "超时",
					message: `超过 30 分钟未完成，已停止跟踪（${summary}）`,
					at: new Date().toISOString(),
				},
			],
		});
	}

	const model = await getModel({ id: task.modelId });
	if (!model || !model.enabled) {
		return await markFailed({ userId, task, summary: "模型已不可用", details: task.errorDetails ?? [] });
	}
	const channelRow = task.channelId ? await getChannel(task.channelId) : null;
	const protocol = task.protocol ? getProtocol(task.protocol) : null;
	const family = familyForKind(model.kind);
	const apiKey = channelRow ? await getChannelCredential(channelRow.id) : null;

	if (!channelRow || !protocol || !family || !apiKey || !task.upstreamJobId) {
		// The channel vanished or lost its key mid-flight: treat like a failed
		// attempt so the chain (if any) still gets a chance.
		return await onAttemptDead({
			userId,
			task,
			model,
			message: `${channelRow?.name ?? task.protocol ?? "渠道"} 已不可用（未配置或已禁用）`,
			attemptErrors: [],
		});
	}

	let state: { state: string; url?: string; error?: string };
	try {
		const polled = await protocol.poll(
			{
				protocol: protocol.id,
				channelId: channelRow.id,
				modelId: task.modelId,
				jobId: task.upstreamJobId,
				model: channelRow.models[task.modelId] ?? "",
				baseUrl: channelRow.baseUrl,
				family,
			},
			{ apiKey },
		);
		state = polled;
	} catch (error) {
		state = {
			state: "failed",
			error: error instanceof Error ? error.message : "轮询失败",
		};
	}

	if (state.state === "done" && state.url) {
		try {
			const points = await settleAttempt({ userId, task, model });
			return await markSucceeded({ task, videoUrl: state.url, points });
		} catch (error) {
			// Settle is idempotent; a failed call must never lose the video.
			console.error("settle failed:", error);
			return await markSucceeded({ task, videoUrl: state.url, points: null });
		}
	}

	if (state.state === "pending") {
		if (task.status === "queued") {
			const [updated] = await db
				.update(generationTasks)
				.set({
					status: "generating",
					startedAt: new Date(),
					updatedAt: new Date(),
				})
				.where(eq(generationTasks.id, task.id))
				.returning();
			return updated ?? task;
		}
		return task;
	}

	// Upstream failed this attempt: refund, then fall back unless the task
	// rides a start frame — i2v silently drops frames on re-route, so it must
	// fail instead of degrading (the rule the client used to apply).
	if (task.refId) {
		try {
			await refundTask({
				userId,
				refId: task.refId,
				note: state.error ?? "upstream failed",
				modelId: task.modelId,
			});
		} catch (error) {
			console.error("attempt refund failed:", error);
		}
	}
	return await onAttemptDead({
		userId,
		task,
		model,
		message: state.error ?? "生成失败",
		attemptErrors: [
			{
				channel: channelRow.name,
				message: state.error ?? "生成失败",
				at: new Date().toISOString(),
			},
		],
	});
}

/** Handle a dead attempt: fall back to the next channel or mark failed. */
async function onAttemptDead({
	userId,
	task,
	model,
	message,
	attemptErrors,
}: {
	userId: string;
	task: TGenerationTask;
	model: NonNullable<Awaited<ReturnType<typeof getModel>>>;
	message: string;
	attemptErrors: AttemptErrors;
}): Promise<TGenerationTask> {
	const excluded = [
		...(task.excludedChannels ?? []),
		...(task.channelId ? [task.channelId] : []),
	];
	const details = [...(task.errorDetails ?? []), ...attemptErrors];

	// i2v cannot re-route (the new vendor silently drops the frame), and a
	// chain exhausted by fallbacks has nowhere left to go either.
	if (task.hasStartImage || excluded.length >= MAX_ATTEMPTS) {
		return await markFailed({ userId, task, summary: message, details });
	}

	const resolution = taskResolution(task.params.resolution);
	const cost = estimateModelCost({
		model,
		resolution,
		seconds: typeof task.params.duration === "number" ? task.params.duration : 5,
	});

	const attempt = await submitAttempt({
		userId,
		model,
		params: {
			prompt: task.prompt,
			duration:
				typeof task.params.duration === "number"
					? task.params.duration
					: "auto",
			resolution,
			aspectRatio: task.params.aspect ?? undefined,
			generateAudio: task.params.audio === true,
		},
		exclude: excluded,
		cost,
	});

	if (!attempt.ok) {
		return await markFailed({
			userId,
			task,
			summary: message,
			details: [
				...details,
				...attempt.attemptErrors,
				{
					channel: "回退提交",
					message: attempt.error ?? "提交失败",
					at: new Date().toISOString(),
				},
			],
		});
	}

	const [updated] = await db
		.update(generationTasks)
		.set({
			status: "queued",
			channelId: attempt.channelId,
			protocol: attempt.protocolId,
			upstreamJobId: attempt.upstreamJobId,
			refId: attempt.refId,
			excludedChannels: excluded,
			errorDetails: details,
			pointsFrozen: attempt.frozen,
			updatedAt: new Date(),
		})
		.where(eq(generationTasks.id, task.id))
		.returning();
	return updated ?? task;
}

export async function listTasks({
	userId,
	limit = 50,
}: {
	userId: string;
	limit?: number;
}): Promise<TGenerationTask[]> {
	const active = await db
		.select()
		.from(generationTasks)
		.where(
			and(
				eq(generationTasks.userId, userId),
				inArray(generationTasks.status, [...ACTIVE]),
			),
		)
		.orderBy(asc(generationTasks.createdAt));
	for (const row of active) {
		await syncTask({ userId, task: row });
	}
	return await db
		.select()
		.from(generationTasks)
		.where(eq(generationTasks.userId, userId))
		.orderBy(desc(generationTasks.createdAt))
		.limit(limit);
}

export async function getTask({
	userId,
	id,
}: {
	userId: string;
	id: string;
}): Promise<TGenerationTask | null> {
	const rows = await db
		.select()
		.from(generationTasks)
		.where(and(eq(generationTasks.id, id), eq(generationTasks.userId, userId)))
		.limit(1);
	if (!rows[0]) return null;
	return await syncTask({ userId, task: rows[0] });
}

export async function deleteTask({
	userId,
	id,
}: {
	userId: string;
	id: string;
}): Promise<boolean> {
	const rows = await db
		.delete(generationTasks)
		.where(
			and(
				eq(generationTasks.id, id),
				eq(generationTasks.userId, userId),
				// Only finished work is a "record"; active tasks cannot be deleted.
				inArray(generationTasks.status, [...TERMINAL]),
			),
		)
		.returning({ id: generationTasks.id });
	return rows.length > 0;
}

export async function clearTerminalTasks({
	userId,
}: {
	userId: string;
}): Promise<number> {
	const rows = await db
		.delete(generationTasks)
		.where(
			and(
				eq(generationTasks.userId, userId),
				inArray(generationTasks.status, [...TERMINAL]),
			),
		)
		.returning({ id: generationTasks.id });
	return rows.length;
}

export { isTerminal, TERMINAL };
export type { TGenerationTask };
