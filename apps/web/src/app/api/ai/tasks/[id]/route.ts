import { withRoute } from "@/services/logging/with-route";
import { type NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/auth/guard";
import { deleteTask, getTask } from "@/services/ai/tasks";

/** One task's live state (synced on read). */
// eslint-disable-next-line opencut/prefer-object-params -- Next.js route handler signature
async function getHandler(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const user = await getSessionUser();
	if (!user) {
		return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
	}
	const { id } = await params;
	const task = await getTask({ userId: user.id, id });
	if (!task) {
		return NextResponse.json({ error: "not_found" }, { status: 404 });
	}
	return NextResponse.json({ task });
}

/** Remove a finished record. Active tasks are rejected by the service. */
// eslint-disable-next-line opencut/prefer-object-params -- Next.js route handler signature
async function deleteHandler(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const user = await getSessionUser();
	if (!user) {
		return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
	}
	const { id } = await params;
	const deleted = await deleteTask({ userId: user.id, id });
	if (!deleted) {
		return NextResponse.json({ error: "not_found_or_active" }, { status: 404 });
	}
	return NextResponse.json({ ok: true });
}

export const DELETE = withRoute(deleteHandler);

export const GET = withRoute(getHandler);
