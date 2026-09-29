import { type NextRequest, NextResponse } from "next/server";
import { requireElevatedAdmin } from "@/auth/guard";
import { clientIp } from "@/auth/request-ip";
import { adjustCredits, getBalance } from "@/services/billing/ledger";
import { writeAudit } from "@/services/audit";

/** Manual credit adjustment. Requires a reason; always audited. */
export async function POST(request: NextRequest) {
	const gate = await requireElevatedAdmin();
	if (!gate.ok) {
		return NextResponse.json({ error: gate.status }, { status: gate.status });
	}

	const body = (await request.json()) as {
		userId?: string;
		delta?: number;
		reason?: string;
	};
	if (
		!body.userId ||
		!Number.isFinite(body.delta) ||
		!body.delta ||
		!body.reason?.trim()
	) {
		return NextResponse.json(
			{ error: "userId, non-zero delta and reason are required" },
			{ status: 400 },
		);
	}

	const balance = await adjustCredits({
		userId: body.userId,
		delta: Math.round(body.delta),
		reason: body.reason.trim(),
		actorId: gate.user.id,
	});

	await writeAudit({
		actorId: gate.user.id,
		actorEmail: gate.user.email,
		action: "adjust_credits",
		target: body.userId,
		detail: `${body.delta > 0 ? "+" : ""}${Math.round(body.delta)} · ${body.reason.trim()}`,
		ip: clientIp({ request }),
	});

	return NextResponse.json({ balance });
}

export async function GET(request: NextRequest) {
	const gate = await requireElevatedAdmin();
	if (!gate.ok) {
		return NextResponse.json({ error: gate.status }, { status: gate.status });
	}
	const userId = request.nextUrl.searchParams.get("userId");
	if (!userId) {
		return NextResponse.json({ error: "userId required" }, { status: 400 });
	}
	return NextResponse.json({ balance: await getBalance({ userId }) });
}
