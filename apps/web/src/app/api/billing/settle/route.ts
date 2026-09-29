import { type NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/auth/guard";
import {
	estimateModelCost,
	getModel,
} from "@/services/admin/models";
import {
	getBalance,
	refundTask,
	settleTask,
} from "@/services/billing/ledger";

/**
 * Close out a frozen generation task: settle the actual usage (difference
 * flows back) or refund in full on failure. Idempotent per refId — retries,
 * page reloads and double calls can never book twice.
 */
export async function POST(request: NextRequest) {
	const user = await getSessionUser();
	if (!user) {
		return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
	}

	const body = (await request.json()) as {
		refId?: string;
		modelId?: string;
		resolution?: "480p" | "720p" | "1080p";
		actualSeconds?: number;
		failed?: boolean;
	};
	if (!body.refId) {
		return NextResponse.json({ error: "refId required" }, { status: 400 });
	}

	// Resolved up front so even a refund carries the model it was for.
	const model = body.modelId ? await getModel({ id: body.modelId }) : null;

	if (body.failed) {
		await refundTask({
			userId: user.id,
			refId: body.refId,
			note: "generation failed",
			modelId: model?.id ?? null,
		});
		return NextResponse.json({ balance: await getBalance({ userId: user.id }) });
	}

	const actualSeconds = Math.min(
		Math.max(Math.round(body.actualSeconds ?? 5), 1),
		15,
	);
	if (model) {
		const actual = estimateModelCost({
			model,
			resolution: body.resolution ?? "720p",
			seconds: actualSeconds,
		});
		await settleTask({
			userId: user.id,
			refId: body.refId,
			actual,
			note: `${model.label} ${actualSeconds}s`,
			modelId: model.id,
		});
	}

	return NextResponse.json({ balance: await getBalance({ userId: user.id }) });
}
