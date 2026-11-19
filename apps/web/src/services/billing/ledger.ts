import {
	and,
	desc,
	eq,
	gte,
	inArray,
	isNotNull,
	isNull,
	lte,
	sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
	creditLedger,
	generationTasks,
	redeemCodes as redeemCodesTable,
} from "@/db/schema";

export const SIGNUP_BONUS_CREDITS = 500;

export type LedgerKind =
	| "grant"
	| "redeem"
	| "freeze"
	| "settle"
	| "refund"
	| "adjust";

/** Sum of all entries — the balance is always replayable from the books. */
export async function getBalance({
	userId,
}: {
	userId: string;
}): Promise<number> {
	const rows = await db
		.select({
			total: sql<number>`coalesce(sum(${creditLedger.amount}), 0)`,
		})
		.from(creditLedger)
		.where(eq(creditLedger.userId, userId));
	return Number(rows[0]?.total ?? 0);
}

class LedgerError extends Error {
	constructor(
		message: string,
		readonly code: "insufficient" | "conflict",
	) {
		super(message);
	}
}

/**
 * Append one ledger row inside a transaction: compute the running balance,
 * write the snapshot. Idempotent on (kind, refId) — a duplicate write is a
 * no-op that returns null so callers can tell "already done" from "done".
 */
async function appendEntry({
	userId,
	amount,
	kind,
	refId,
	note = "",
	actorId = null,
	modelId = null,
	seconds = null,
}: {
	userId: string;
	amount: number;
	kind: LedgerKind;
	refId: string | null;
	note?: string;
	actorId?: string | null;
	modelId?: string | null;
	seconds?: number | null;
}): Promise<{ balanceAfter: number } | null> {
	return db.transaction(async (tx) => {
		const inserted = await tx
			.insert(creditLedger)
			.values({
				id: crypto.randomUUID(),
				userId,
				amount,
				balanceAfter: 0,
				kind,
				refId,
				modelId,
				seconds,
				note,
				actorId,
			})
			.onConflictDoNothing()
			.returning({ id: creditLedger.id });

		if (inserted.length === 0) {
			return null; // (kind, refId) already booked — idempotent replay
		}

		const sums = await tx
			.select({ total: sql<number>`coalesce(sum(${creditLedger.amount}), 0)` })
			.from(creditLedger)
			.where(eq(creditLedger.userId, userId));
		const balanceAfter = Number(sums[0]?.total ?? 0);

		await tx
			.update(creditLedger)
			.set({ balanceAfter })
			.where(
				and(
					eq(creditLedger.userId, userId),
					eq(creditLedger.id, inserted[0].id),
				),
			);

		return { balanceAfter };
	});
}

/** One-time signup bonus. Safe to call on every login. */
export async function grantSignupBonus({
	userId,
}: {
	userId: string;
}): Promise<void> {
	await appendEntry({
		userId,
		amount: SIGNUP_BONUS_CREDITS,
		kind: "grant",
		refId: `signup:${userId}`,
		note: "signup bonus",
	});
}

export async function getFrozenAmount({
	userId,
}: {
	userId: string;
}): Promise<number> {
	// Open freezes only: the ledger is append-only, so a refunded or settled
	// job keeps its freeze row — it must not keep counting as reserved credit.
	const rows = await db
		.select({ total: sql<number>`coalesce(sum(${creditLedger.amount}), 0)` })
		.from(creditLedger)
		.where(
			and(
				eq(creditLedger.userId, userId),
				eq(creditLedger.kind, "freeze"),
				sql`not exists (
					select 1 from ${creditLedger} closed
					where closed.user_id = ${creditLedger.userId}
						and closed.ref_id = ${creditLedger.refId}
						and closed.kind in ('settle', 'refund')
				)`,
			),
		);
	return -Number(rows[0]?.total ?? 0);
}

/**
 * Whether this ref has already been used to freeze credits.
 *
 * Freezing is idempotent per (kind, refId), so a replayed ref would book no
 * second charge and let the second job run free — callers refuse a ref they see
 * here instead of leaning on that idempotency.
 */
export async function hasFrozenRef({
	refId,
}: {
	refId: string;
}): Promise<boolean> {
	const rows = await db
		.select({ id: creditLedger.id })
		.from(creditLedger)
		.where(and(eq(creditLedger.kind, "freeze"), eq(creditLedger.refId, refId)))
		.limit(1);
	return rows.length > 0;
}

/**
 * Whether the caller's own ledger holds a freeze under this refId — the
 * poll-route guard: a poll handle must at least point at a freeze the caller
 * paid for (append-only ledger, so the row outlives settle/refund).
 */
export async function userOwnsFreezeRef({
	userId,
	refId,
}: {
	userId: string;
	refId: string;
}): Promise<boolean> {
	const rows = await db
		.select({ id: creditLedger.id })
		.from(creditLedger)
		.where(
			and(
				eq(creditLedger.userId, userId),
				eq(creditLedger.kind, "freeze"),
				eq(creditLedger.refId, refId),
			),
		)
		.limit(1);
	return rows.length > 0;
}

/**
 * How many generations this user has started for one model today, counted from
 * the freeze rows — a job is counted when it is submitted, not when it lands.
 * Backs the model registry's `dailyLimit`.
 */
export async function countFreezesToday({
	userId,
	modelId,
}: {
	userId: string;
	modelId: string;
}): Promise<number> {
	const rows = await db
		.select({ count: sql<number>`count(*)` })
		.from(creditLedger)
		.where(
			and(
				eq(creditLedger.userId, userId),
				eq(creditLedger.kind, "freeze"),
				eq(creditLedger.modelId, modelId),
				gte(creditLedger.createdAt, sql`date_trunc('day', now())`),
			),
		);
	return Number(rows[0]?.count ?? 0);
}

/**
 * Reserve credits before a generation task runs. Throws LedgerError
 * ("insufficient") when the balance cannot cover the estimate.
 */
export async function freezeForTask({
	userId,
	refId,
	amount,
	note = "",
	modelId = null,
	seconds = null,
}: {
	userId: string;
	refId: string;
	amount: number;
	note?: string;
	modelId?: string | null;
	seconds?: number | null;
}): Promise<{ balanceAfter: number }> {
	// One transaction holding a per-user advisory lock: the balance check and
	// the insert cannot interleave with a concurrent freeze, so two parallel
	// submits can no longer both pass the check and drive the balance negative.
	return db.transaction(async (tx) => {
		await tx.execute(
			sql`select pg_advisory_xact_lock(hashtext(${userId}))`,
		);
		const sums = await tx
			.select({ total: sql<number>`coalesce(sum(${creditLedger.amount}), 0)` })
			.from(creditLedger)
			.where(eq(creditLedger.userId, userId));
		const balance = Number(sums[0]?.total ?? 0);
		if (balance < amount) {
			throw new LedgerError("insufficient balance", "insufficient");
		}

		const inserted = await tx
			.insert(creditLedger)
			.values({
				id: crypto.randomUUID(),
				userId,
				amount: -amount,
				balanceAfter: balance - amount,
				kind: "freeze",
				refId,
				modelId,
				seconds,
				note,
			})
			.onConflictDoNothing()
			.returning({ id: creditLedger.id });

		if (inserted.length === 0) {
			// Already frozen for this task — return the effective balance.
			return { balanceAfter: balance };
		}
		return { balanceAfter: balance - amount };
	});
}

/**
 * Book the actual usage against a frozen amount; the difference flows back
 * automatically because settle writes +（frozen − actual). No-op when nothing
 * was frozen. Idempotent per refId.
 */
export async function settleTask({
	userId,
	refId,
	actual,
	note = "",
	modelId = null,
}: {
	userId: string;
	refId: string;
	actual: number;
	note?: string;
	modelId?: string | null;
}): Promise<void> {
	const frozenRows = await db
		.select({ amount: creditLedger.amount })
		.from(creditLedger)
		.where(
			and(
				eq(creditLedger.userId, userId),
				eq(creditLedger.kind, "freeze"),
				eq(creditLedger.refId, refId),
			),
		)
		.limit(1);
	const frozen = frozenRows[0] ? -frozenRows[0].amount : 0;
	const diff = frozen - actual;
	if (diff <= 0) {
		return;
	}
	await appendEntry({
		userId,
		amount: diff,
		kind: "settle",
		refId,
		note,
		modelId,
	});
}

/** Full refund when a generation fails. Idempotent per refId. */
export async function refundTask({
	userId,
	refId,
	note = "",
	modelId = null,
}: {
	userId: string;
	refId: string;
	note?: string;
	modelId?: string | null;
}): Promise<void> {
	const frozenRows = await db
		.select({ amount: creditLedger.amount })
		.from(creditLedger)
		.where(
			and(
				eq(creditLedger.userId, userId),
				eq(creditLedger.kind, "freeze"),
				eq(creditLedger.refId, refId),
			),
		)
		.limit(1);
	const frozen = frozenRows[0] ? -frozenRows[0].amount : 0;
	if (frozen <= 0) {
		return;
	}
	await appendEntry({
		userId,
		amount: frozen,
		kind: "refund",
		refId,
		note: note || "task failed",
		modelId,
	});
}

/**
 * Refund freezes that never got a settle or refund — jobs whose client died
 * mid-poll (tab closed, network dropped). Light-flow jobs (tools/audio/image)
 * have no task row, so nothing else reconciles them and the points used to
 * stay spent forever. A freeze older than the TTL whose refId has no matching
 * settle/refund row is refunded here; refIds still owned by an active
 * generation_task are skipped, so long renders are never cut short.
 * Called on /api/billing/me, which every balance refresh hits — the books
 * self-heal the next time the user shows up.
 */
const ORPHAN_FREEZE_TTL_MS = 24 * 60 * 60 * 1000;

export async function sweepOrphanFreezes({
	userId,
	olderThanMs = ORPHAN_FREEZE_TTL_MS,
}: {
	userId: string;
	olderThanMs?: number;
}): Promise<number> {
	const cutoff = new Date(Date.now() - olderThanMs);
	const candidates = await db
		.select({
			refId: creditLedger.refId,
			modelId: creditLedger.modelId,
		})
		.from(creditLedger)
		.where(
			and(
				eq(creditLedger.userId, userId),
				eq(creditLedger.kind, "freeze"),
				isNotNull(creditLedger.refId),
				// Freeze rows written before the cutoff: no live job can still
				// own them (active jobs are minutes old, TTL is a day).
				lte(creditLedger.createdAt, cutoff),
			),
		);
	if (candidates.length === 0) return 0;

	const activeRefs = new Set(
		(
			await db
				.select({ refId: generationTasks.refId })
				.from(generationTasks)
				.where(
					and(
						eq(generationTasks.userId, userId),
						inArray(generationTasks.status, [
							"submitting",
							"queued",
							"generating",
						]),
					),
				)
		)
			.map((row) => row.refId)
			.filter((refId): refId is string => Boolean(refId)),
	);

	let refunded = 0;
	for (const candidate of candidates) {
		const refId = candidate.refId;
		if (!refId || activeRefs.has(refId)) continue;
		const closed = await db
			.select({ id: creditLedger.id })
			.from(creditLedger)
			.where(
				and(
					eq(creditLedger.userId, userId),
					inArray(creditLedger.kind, ["settle", "refund"]),
					eq(creditLedger.refId, refId),
				),
			)
			.limit(1);
		if (closed.length > 0) continue;
		await refundTask({
			userId,
			refId,
			note: "orphan freeze sweep",
			modelId: candidate.modelId,
		});
		refunded += 1;
	}
	return refunded;
}

/**
 * Attribute upstream-reported token usage to the job's freeze row — the
 * per-model/per-user aggregation reads freezes, so the usage lands there
 * instead of on a settle row that may not exist (pricePerCall models).
 */
export async function setFreezeTokens({
	refId,
	tokens,
}: {
	refId: string | null | undefined;
	tokens: number | null | undefined;
}): Promise<void> {
	if (!refId || !tokens || tokens <= 0) return;
	await db
		.update(creditLedger)
		.set({ tokens })
		.where(
			and(eq(creditLedger.kind, "freeze"), eq(creditLedger.refId, refId)),
		);
}

export async function adjustCredits({
	userId,
	delta,
	reason,
	actorId,
}: {
	userId: string;
	delta: number;
	reason: string;
	actorId: string;
}): Promise<number> {
	const result = await appendEntry({
		userId,
		amount: delta,
		kind: "adjust",
		refId: crypto.randomUUID(),
		note: reason,
		actorId,
	});
	return result?.balanceAfter ?? (await getBalance({ userId }));
}

export async function redeemCode({
	userId,
	code,
}: {
	userId: string;
	code: string;
}): Promise<{ credits: number; balance: number }> {
	const normalized = code.trim().toUpperCase();
	const result = await db.transaction(async (tx) => {
		const claimed = await tx
			.update(redeemCodesTable)
			.set({ redeemedBy: userId, redeemedAt: new Date() })
			.where(
				and(
					eq(redeemCodesTable.code, normalized),
					sql`${redeemCodesTable.redeemedBy} is null`,
				),
			)
			.returning({ credits: redeemCodesTable.credits });
		return claimed[0] ?? null;
	});
	if (!result) {
		throw new LedgerError("code invalid or already used", "conflict");
	}
	await appendEntry({
		userId,
		amount: result.credits,
		kind: "redeem",
		refId: normalized,
		note: "redeem code",
	});
	return { credits: result.credits, balance: await getBalance({ userId }) };
}

export async function listTransactions({
	userId,
	limit = 50,
}: {
	userId: string;
	limit?: number;
}): Promise<
	Array<{
		id: string;
		amount: number;
		balanceAfter: number;
		kind: string;
		note: string;
		createdAt: Date;
	}>
> {
	return db
		.select({
			id: creditLedger.id,
			amount: creditLedger.amount,
			balanceAfter: creditLedger.balanceAfter,
			kind: creditLedger.kind,
			note: creditLedger.note,
			createdAt: creditLedger.createdAt,
		})
		.from(creditLedger)
		.where(eq(creditLedger.userId, userId))
		.orderBy(desc(creditLedger.createdAt))
		.limit(limit);
}

export { LedgerError };
