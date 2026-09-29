import { type NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/auth/guard";
import { redeemCode } from "@/services/billing/ledger";

/** v1 top-up channel: redeem a code, credits land in the ledger instantly. */
export async function POST(request: NextRequest) {
	const user = await getSessionUser();
	if (!user) {
		return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
	}

	const body = (await request.json()) as { code?: string };
	if (!body.code?.trim()) {
		return NextResponse.json({ error: "code required" }, { status: 400 });
	}

	try {
		const result = await redeemCode({ userId: user.id, code: body.code });
		return NextResponse.json(result);
	} catch {
		return NextResponse.json(
			{ error: "code_invalid" },
			{ status: 409 },
		);
	}
}
