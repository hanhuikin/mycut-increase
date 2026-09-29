import { type NextRequest, NextResponse } from "next/server";
import { requireElevatedAdmin } from "@/auth/guard";
import { listAudit, listAuditActions } from "@/services/audit";

const MAX_LIMIT = 200;

/** Paged audit log, optionally filtered to a single action. */
export async function GET(request: NextRequest) {
	const gate = await requireElevatedAdmin();
	if (!gate.ok) {
		return NextResponse.json({ error: gate.status }, { status: gate.status });
	}

	const { searchParams } = new URL(request.url);
	const action = searchParams.get("action") || undefined;
	const limit = Math.min(
		Math.max(Number(searchParams.get("limit")) || 50, 1),
		MAX_LIMIT,
	);
	const offset = Math.max(Number(searchParams.get("offset")) || 0, 0);

	const [page, actions] = await Promise.all([
		listAudit({ action, limit, offset }),
		listAuditActions(),
	]);

	return NextResponse.json({ ...page, actions, limit, offset });
}
