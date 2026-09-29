import { type NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/auth/guard";
import {
	estimateModelCost,
	getModel,
} from "@/services/admin/models";
import {
	freezeForTask,
	getBalance,
	LedgerError,
} from "@/services/billing/ledger";

/**
 * Freeze the estimated cost before a generation task runs. The amount is
 * computed server-side from the model registry — never trusted from the
 * client. Idempotency key: the client-generated task refId.
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
		seconds?: number;
	};
	if (!body.refId || !body.modelId) {
		return NextResponse.json(
			{ error: "refId and modelId required" },
			{ status: 400 },
		);
	}

	const model = await getModel({ id: body.modelId });
	if (!model || !model.enabled) {
		return NextResponse.json({ error: "model_unavailable" }, { status: 409 });
	}

	const seconds = Math.min(Math.max(Math.round(body.seconds ?? 5), 1), 15);
	const resolution = body.resolution ?? "720p";
	const cost = estimateModelCost({ model, resolution, seconds });
	if (cost <= 0) {
		// Local / free model — nothing to freeze.
		return NextResponse.json({ frozen: 0, balance: null });
	}

	try {
		const result = await freezeForTask({
			userId: user.id,
			refId: body.refId,
			amount: cost,
			note: `${model.label} ${resolution} ${seconds}s`,
			modelId: model.id,
			seconds,
		});
		return NextResponse.json({
			frozen: cost,
			balance: result.balanceAfter,
		});
	} catch (error) {
		if (error instanceof LedgerError && error.code === "insufficient") {
			const balance = await getBalance({ userId: user.id });
			return NextResponse.json(
				{ error: "insufficient", cost, balance },
				{ status: 402 },
			);
		}
		throw error;
	}
}
