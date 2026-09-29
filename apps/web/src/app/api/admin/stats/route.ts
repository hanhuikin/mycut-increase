import { type NextRequest, NextResponse } from "next/server";
import { requireElevatedAdmin } from "@/auth/guard";
import { STATS_RANGES, type StatsRange, getStats } from "@/services/admin/stats";

/** Usage dashboard aggregates over the credit ledger. */
export async function GET(request: NextRequest) {
	const gate = await requireElevatedAdmin();
	if (!gate.ok) {
		return NextResponse.json({ error: gate.status }, { status: gate.status });
	}

	const { searchParams } = new URL(request.url);
	const requested = searchParams.get("range") ?? "24h";
	const range: StatsRange = (STATS_RANGES as string[]).includes(requested)
		? (requested as StatsRange)
		: "24h";

	// Whole minutes, clamped to the real-world range of UTC offsets.
	const rawOffset = Number(searchParams.get("offset"));
	const offsetMinutes = Number.isFinite(rawOffset)
		? Math.max(-14 * 60, Math.min(14 * 60, Math.trunc(rawOffset)))
		: 0;

	return NextResponse.json(await getStats({ range, offsetMinutes }));
}
