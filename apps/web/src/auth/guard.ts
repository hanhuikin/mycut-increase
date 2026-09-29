import { cookies, headers } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";
import { auth } from "@/auth/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { webEnv } from "@/env/web";

export interface SessionUser {
	id: string;
	name: string;
	email: string;
	role: "user" | "admin";
	plan: "free" | "pro";
	twoFactorEnabled: boolean;
}

export const ADMIN_GATE_COOKIE = "mc_admin_gate";
export const ADMIN_GATE_TTL_MS = 30 * 60 * 1000;

/** Better-auth session + our db row, resolved to the fields the UI needs. */
export async function getSessionUser(): Promise<SessionUser | null> {
	const headerList = await headers();
	const authSession = await auth.api.getSession({ headers: headerList });
	if (!authSession?.user) {
		return null;
	}
	const rows = await db
		.select({
			id: users.id,
			name: users.name,
			email: users.email,
			role: users.role,
			plan: users.plan,
			banned: users.banned,
			twoFactorEnabled: users.twoFactorEnabled,
		})
		.from(users)
		.where(eq(users.id, authSession.user.id))
		.limit(1);
	const row = rows[0];
	if (!row || row.banned) {
		return null;
	}
	return {
		id: row.id,
		name: row.name,
		email: row.email,
		role: row.role === "admin" ? "admin" : "user",
		plan: row.plan === "pro" ? "pro" : "free",
		twoFactorEnabled: row.twoFactorEnabled,
	};
}

function gateSignature({ expiryMs }: { expiryMs: number }): string {
	return createHmac("sha256", webEnv.BETTER_AUTH_SECRET)
		.update(`mc-admin-gate:${expiryMs}`)
		.digest("hex");
}

/** Issue the 30-minute elevated-admin cookie. */
export async function issueAdminGate(): Promise<void> {
	const expiryMs = Date.now() + ADMIN_GATE_TTL_MS;
	const store = await cookies();
	store.set(ADMIN_GATE_COOKIE, `${expiryMs}.${gateSignature({ expiryMs })}`, {
		httpOnly: true,
		sameSite: "lax",
		path: "/",
		maxAge: ADMIN_GATE_TTL_MS / 1000,
	});
}

/** True when the request carries a valid, unexpired elevated-admin cookie. */
export async function hasAdminGate(): Promise<boolean> {
	const store = await cookies();
	const raw = store.get(ADMIN_GATE_COOKIE)?.value;
	if (!raw) {
		return false;
	}
	const [expiryRaw, signature] = raw.split(".");
	const expiryMs = Number(expiryRaw);
	if (!Number.isFinite(expiryMs) || expiryMs < Date.now() || !signature) {
		return false;
	}
	const expected = Buffer.from(gateSignature({ expiryMs }), "hex");
	const provided = Buffer.from(signature, "hex");
	return (
		expected.length === provided.length && timingSafeEqual(expected, provided)
	);
}

/**
 * The elevated gate is a second factor on top of the admin role: the role is
 * checked on every admin API call, the gate bounds it in time (30 min) and is
 * issued only after a password (+ TOTP) re-verification.
 */
export async function requireElevatedAdmin(): Promise<
	{ ok: true; user: SessionUser } | { ok: false; status: number }
> {
	const user = await getSessionUser();
	if (!user) {
		return { ok: false, status: 401 };
	}
	if (user.role !== "admin") {
		return { ok: false, status: 403 };
	}
	if (!(await hasAdminGate())) {
		return { ok: false, status: 428 }; // Precondition Required: elevate first
	}
	return { ok: true, user };
}
