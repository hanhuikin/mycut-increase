import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLog } from "@/db/schema";

export async function writeAudit({
	actorId = null,
	actorEmail = "",
	action,
	target = "",
	detail = "",
	ip = "",
}: {
	actorId?: string | null;
	actorEmail?: string;
	action: string;
	target?: string;
	detail?: string;
	ip?: string;
}): Promise<void> {
	// U+FFFD means some earlier step decoded bytes with the wrong codec and the
	// text is already lost; this once shipped to the log from a deleted code
	// path (see the zz-test-model entry). Nothing here can repair it, but the
	// run should say so loudly instead of filing silent garbage.
	const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);
	if (detail.includes(REPLACEMENT_CHAR) || target.includes(REPLACEMENT_CHAR)) {
		console.warn(
			`[audit] replacement characters in entry "${action}" — text was corrupted before writeAudit`,
		);
	}

	await db.insert(auditLog).values({
		id: crypto.randomUUID(),
		actorId,
		actorEmail,
		action,
		target,
		detail,
		ip,
	});
}

export interface AuditEntry {
	id: string;
	actorEmail: string;
	action: string;
	target: string;
	detail: string;
	createdAt: Date;
}

export interface AuditPage {
	entries: AuditEntry[];
	total: number;
}

/** Newest first, optionally narrowed to one action and paged. */
export async function listAudit({
	action,
	limit = 50,
	offset = 0,
}: {
	action?: string;
	limit?: number;
	offset?: number;
} = {}): Promise<AuditPage> {
	const filter = action ? eq(auditLog.action, action) : undefined;

	const [entries, counted] = await Promise.all([
		db
			.select({
				id: auditLog.id,
				actorEmail: auditLog.actorEmail,
				action: auditLog.action,
				target: auditLog.target,
				detail: auditLog.detail,
				createdAt: auditLog.createdAt,
			})
			.from(auditLog)
			.where(filter)
			.orderBy(desc(auditLog.createdAt))
			.limit(limit)
			.offset(offset),
		db
			.select({ count: sql<number>`count(*)::int` })
			.from(auditLog)
			.where(filter),
	]);

	return { entries, total: counted[0]?.count ?? 0 };
}

/** Distinct actions present in the log, for the filter control. */
export async function listAuditActions(): Promise<string[]> {
	const rows = await db
		.selectDistinct({ action: auditLog.action })
		.from(auditLog)
		.orderBy(auditLog.action);
	return rows.map((row) => row.action);
}
