import { NextResponse } from "next/server";
import { getSessionUser } from "@/auth/guard";
import {
	getBalance,
	grantSignupBonus,
	listTransactions,
} from "@/services/billing/ledger";

/** The signed-in user's credit state. First call grants the signup bonus. */
export async function GET() {
	const user = await getSessionUser();
	if (!user) {
		return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
	}

	await grantSignupBonus({ userId: user.id });
	const balance = await getBalance({ userId: user.id });
	const transactions = await listTransactions({ userId: user.id, limit: 10 });

	return NextResponse.json({
		balance,
		plan: user.plan,
		role: user.role,
		transactions,
	});
}
