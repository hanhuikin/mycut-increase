import { type NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/auth/guard";
import { checkRateLimit } from "@/auth/rate-limit";
import {
	clearTerminalTasks,
	listTasks,
} from "@/services/ai/tasks";

/**
 * The current user's generation tasks. Reading syncs active tasks in place
 * (upstream poll → settle/refund/fallback), so the response is always the
 * live state; the browser just renders it.
 */
export async function GET(request: NextRequest) {
	const user = await getSessionUser();
	if (!user) {
		return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
	}

	const { limited } = await checkRateLimit({
		request,
		keySuffix: "tasks",
	});
	if (limited) {
		return NextResponse.json({ error: "too_many_requests" }, { status: 429 });
	}

	const tasks = await listTasks({ userId: user.id });
	return NextResponse.json({ tasks });
}

/** Clear finished records. Active tasks are never touched. */
export async function DELETE(_request: NextRequest) {
	const user = await getSessionUser();
	if (!user) {
		return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
	}
	const cleared = await clearTerminalTasks({ userId: user.id });
	return NextResponse.json({ cleared });
}
