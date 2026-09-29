import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "@/db";
import { creditLedger, redeemCodes as redeemCodesTable } from "@/db/schema";

export const SIGNUP_BONUS_CREDITS = 500;

export type LedgerKind =
	"grant" | "redeem" | "freeze" | "settle" | "refund" | "adjust";

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
	const rows = await db
		.select({ total: sql<number>`coalesce(sum(${creditLedger.amount}), 0)` })
		.from(creditLedger)
		.where(
			and(eq(creditLedger.userId, userId), eq(creditLedger.kind, "freeze")),
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
		.where(
			and(eq(creditLedger.kind, "freeze"), eq(creditLedger.refId, refId)),
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
	const balance = await getBalance({ userId });
	if (balance < amount) {
		throw new LedgerError("insufficient balance", "insufficient");
	}
	const result = await appendEntry({
		userId,
		amount: -amount,
		kind: "freeze",
		refId,
		note,
		modelId,
		seconds,
	});
	if (!result) {
		// Already frozen for this task — return the effective balance.
		return { balanceAfter: await getBalance({ userId }) };
	}
	return result;
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
