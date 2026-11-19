import { withRoute } from "@/services/logging/with-route";
import { NextResponse } from "next/server";
import { getSessionUser } from "@/auth/guard";
import {
	getBalance,
	getFrozenAmount,
	grantSignupBonus,
	listTransactions,
	sweepOrphanFreezes,
} from "@/services/billing/ledger";

/** The signed-in user's credit state. First call grants the signup bonus. */
async function getHandler() {
	const user = await getSessionUser();
	if (!user) {
		return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
	}

	await grantSignupBonus({ userId: user.id });
	// Self-heal: freezes abandoned by dead clients (tab closed mid-poll) get
	// refunded here, on every balance refresh, once they are old enough that no
	// live job can still own them.
	await sweepOrphanFreezes({ userId: user.id });
	const balance = await getBalance({ userId: user.id });
	// balance counts frozen amounts in; available subtracts them back out.
	const frozen = await getFrozenAmount({ userId: user.id });
	const transactions = await listTransactions({ userId: user.id, limit: 10 });

	return NextResponse.json({
		balance,
		available: balance - frozen,
		frozen,
		plan: user.plan,
		role: user.role,
		transactions,
	});
}

export const GET = withRoute(getHandler);
