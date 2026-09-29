import { type NextRequest, NextResponse } from "next/server";
import { desc, eq, ilike, or } from "drizzle-orm";
import { requireElevatedAdmin } from "@/auth/guard";
import { clientIp } from "@/auth/request-ip";
import { db } from "@/db";
import { users } from "@/db/schema";
import { writeAudit } from "@/services/audit";

export async function GET(request: NextRequest) {
	const gate = await requireElevatedAdmin();
	if (!gate.ok) {
		return NextResponse.json({ error: gate.status }, { status: gate.status });
	}

	const search = request.nextUrl.searchParams.get("q")?.trim() ?? "";
	const rows = await db
		.select({
			id: users.id,
			email: users.email,
			name: users.name,
			role: users.role,
			plan: users.plan,
			banned: users.banned,
			banReason: users.banReason,
			twoFactorEnabled: users.twoFactorEnabled,
			createdAt: users.createdAt,
		})
		.from(users)
		.where(
			search
				? or(ilike(users.email, `%${search}%`), ilike(users.name, `%${search}%`))
				: undefined,
		)
		.orderBy(desc(users.createdAt))
		.limit(200);

	return NextResponse.json({ users: rows });
}

export async function PATCH(request: NextRequest) {
	const gate = await requireElevatedAdmin();
	if (!gate.ok) {
		return NextResponse.json({ error: gate.status }, { status: gate.status });
	}

	const body = (await request.json()) as {
		userId?: string;
		action?: "ban" | "unban" | "set_role" | "set_plan";
		reason?: string;
		role?: string;
		plan?: string;
	};
	if (!body.userId || !body.action) {
		return NextResponse.json(
			{ error: "userId and action required" },
			{ status: 400 },
		);
	}
	if (body.userId === gate.user.id && body.action !== "set_plan") {
		return NextResponse.json(
			{ error: "cannot modify your own account this way" },
			{ status: 400 },
		);
	}

	const ip = clientIp({ request });
	let auditAction = body.action;
	let detail = body.reason ?? "";

	switch (body.action) {
		case "ban": {
			await db
				.update(users)
				.set({
					banned: true,
					banReason: body.reason ?? "",
					updatedAt: new Date(),
				})
				.where(eq(users.id, body.userId));
			detail = body.reason ?? "";
			break;
		}
		case "unban": {
			await db
				.update(users)
				.set({
					banned: false,
					banReason: null,
					banExpires: null,
					updatedAt: new Date(),
				})
				.where(eq(users.id, body.userId));
			break;
		}
		case "set_role": {
			if (body.role !== "admin" && body.role !== "user") {
				return NextResponse.json({ error: "invalid role" }, { status: 400 });
			}
			await db
				.update(users)
				.set({ role: body.role, updatedAt: new Date() })
				.where(eq(users.id, body.userId));
			detail = `role=${body.role}`;
			auditAction = "set_role";
			break;
		}
		case "set_plan": {
			if (body.plan !== "free" && body.plan !== "pro") {
				return NextResponse.json({ error: "invalid plan" }, { status: 400 });
			}
			await db
				.update(users)
				.set({ plan: body.plan, updatedAt: new Date() })
				.where(eq(users.id, body.userId));
			detail = `plan=${body.plan}`;
			auditAction = "set_plan";
			break;
		}
		default:
			return NextResponse.json({ error: "unknown action" }, { status: 400 });
	}

	await writeAudit({
		actorId: gate.user.id,
		actorEmail: gate.user.email,
		action: auditAction,
		target: body.userId,
		detail,
		ip,
	});

	return NextResponse.json({ ok: true });
}
