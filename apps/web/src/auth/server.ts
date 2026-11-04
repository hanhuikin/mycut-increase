import { betterAuth, type RateLimit } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, twoFactor, haveIBeenPwned } from "better-auth/plugins";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getRedis } from "@/services/redis";
import { webEnv } from "@/env/web";

export const auth = betterAuth({
	database: drizzleAdapter(db, {
		provider: "pg",
		usePlural: true,
	}),
	secret: webEnv.BETTER_AUTH_SECRET,
	user: {
		deleteUser: {
			enabled: true,
		},
	},
	emailAndPassword: {
		enabled: true,
		minPasswordLength: 10,
		/**
		 * No SMTP provider is wired up yet: the reset link is only logged on the
		 * server. The forgot/reset UI is complete, delivery is the missing piece.
		 */
		requireEmailVerification: false,
		sendResetPassword: async ({ user, url }) => {
			console.info(`[mailer:stub] password reset for ${user.email}: ${url}`);
		},
	},
	rateLimit: {
		storage: "secondary-storage",
		customStorage: {
			get: async (key) => {
				const raw = await getRedis().get(`ba-rate-limit:${key}`);
				return raw ? (JSON.parse(raw) as RateLimit) : undefined;
			},
			set: async (key, value) => {
				await getRedis().set(`ba-rate-limit:${key}`, JSON.stringify(value));
			},
		},
	},
	plugins: [admin(), twoFactor(), haveIBeenPwned()],
	baseURL: webEnv.NEXT_PUBLIC_SITE_URL,
	appName: "MyCut",
	// TRUSTED_ORIGINS: comma-separated extra origins (e.g. the LAN-IP https
	// variant used for local device testing) accepted alongside the baseURL.
	//
	// The Host the request actually arrived on is trusted too: behind an ingress
	// the public domain is not SITE_URL's business to know, and a missing
	// SITE_URL (zod defaults to localhost) would otherwise 403 every browser
	// login with "Invalid origin". This cannot widen cross-site access — a
	// browser only emits that Origin for a request sent to that same host.
	trustedOrigins: (request) => {
		const origins = new Set<string>([
			webEnv.NEXT_PUBLIC_SITE_URL,
			...(process.env.TRUSTED_ORIGINS ?? "")
				.split(",")
				.map((origin) => origin.trim())
				.filter(Boolean),
		]);
		const servedOrigin = originFromHost(request);
		if (servedOrigin) origins.add(servedOrigin);
		return [...origins];
	},
});

export type Auth = typeof auth;

/**
 * The origin this request was served on, as the client's browser would spell
 * it: the proxy's forwarded host/proto when present, otherwise the request's own
 * URL (Next builds it from the Host header).
 */
function originFromHost(request: Request | undefined): string | null {
	if (!request) return null;
	const first = (value: string | null) => value?.split(",")[0]?.trim() || null;

	try {
		const url = new URL(request.url);
		const host = first(request.headers.get("x-forwarded-host")) ?? url.host;
		const proto =
			first(request.headers.get("x-forwarded-proto")) ??
			url.protocol.replace(":", "");
		return host ? `${proto}://${host}` : null;
	} catch {
		return null;
	}
}

/** The signed-in user's role, or null when unauthenticated. */
export async function getUserRole({
	userId,
}: {
	userId: string;
}): Promise<"user" | "admin" | null> {
	const rows = await db
		.select({ role: users.role })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	const role = rows[0]?.role;
	return role === "admin" ? "admin" : role === "user" ? "user" : null;
}
