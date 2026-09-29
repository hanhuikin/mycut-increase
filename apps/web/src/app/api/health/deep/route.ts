import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/db";

/**
 * Liveness plus database reachability. The plain /api/health answers from the
 * process alone; this one lets the load balancer evict a node that is up but
 * cannot reach Postgres, instead of serving every request an error.
 */
export async function GET() {
	try {
		await db.execute(sql`select 1`);
		return NextResponse.json({ status: "ok" });
	} catch (error) {
		return NextResponse.json(
			{
				status: "unhealthy",
				error: error instanceof Error ? error.message : "unknown",
			},
			{ status: 503 },
		);
	}
}
