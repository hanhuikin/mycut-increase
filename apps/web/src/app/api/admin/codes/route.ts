import { type NextRequest, NextResponse } from "next/server";
import { requireElevatedAdmin } from "@/auth/guard";
import { db } from "@/db";
import { redeemCodes } from "@/db/schema";
import { writeAudit } from "@/services/audit";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	const chars = [...bytes].map(
		(byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length],
	);
	return `MC-${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

/** Generate a batch of redeem codes (v1 top-up channel). */
export async function POST(request: NextRequest) {
	const gate = await requireElevatedAdmin();
	if (!gate.ok) {
		return NextResponse.json({ error: gate.status }, { status: gate.status });
	}

	const body = (await request.json()) as { count?: number; credits?: number };
	const count = Math.min(Math.max(Math.round(body.count ?? 0), 1), 100);
	const credits = Math.round(body.credits ?? 0);
	if (!credits || credits <= 0) {
		return NextResponse.json({ error: "credits required" }, { status: 400 });
	}

	const batchId = crypto.randomUUID();
	const codes = Array.from({ length: count }, generateCode);
	await db.insert(redeemCodes).values(
		codes.map((code) => ({ code, credits, batchId })),
	);

	await writeAudit({
		actorId: gate.user.id,
		actorEmail: gate.user.email,
		action: "redeem_batch",
		target: batchId,
		detail: `${count} × ${credits} 点`,
		ip: request.headers.get("x-forwarded-for") ?? "",
	});

	return NextResponse.json({ batchId, codes });
}
