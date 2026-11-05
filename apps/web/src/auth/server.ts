import { betterAuth, type RateLimit } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { admin, twoFactor, haveIBeenPwned } from "better-auth/plugins";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getRedis } from "@/services/redis";
import { logger } from "@/services/logging/logger";
import { webEnv } from "@/env/web";

export const auth = betterAuth({
	database: drizzleAdapter(db, {
		provider: "pg",
		usePlural: true,
	}),
	// better-auth's default output is plain console.* — which the production
	// build strips (compiler.removeConsole covers the whole bundle). Route its
	// messages through the structured logger instead: JSON lines in the same
	// format as the access logs, with the request's trace_id attached.
	logger: {
		level: "info",
		log: (level, message, ...args) => {
			const emit =
				level === "error"
					? logger.error
					: level === "warn"
						? logger.warn
						: level === "debug"
							? logger.debug
							: logger.info;
			emit(`better-auth: ${message}`, {
				detail:
					args.length === 1 ? args[0] : args.length > 1 ? args : undefined,
			});
		},
	},
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
			// No SMTP provider is wired up yet: the reset link only lands in the
			// server logs (never user-visible).
			logger.info(`password reset link for ${user.email}`, { reset_url: url });
		},
	},
	rateLimit: {
		storage: "secondary-storage",
		// better-auth's built-in rule is 3 sign-ins per 10s *per client IP*. Behind
		// an ingress every request shares one IP, so the whole deployment shares
		// that bucket — a user retrying twice locks out everyone, and each rejected
		// request refreshes the window (the more you click, the longer the lock).
		// 10 per minute still bounds brute force without tripping on ordinary
		// double-clicks and retries.
		customRules: {
			"/sign-in/email": { window: 60, max: 10 },
		},
		customStorage: {
			get: async (key) => {
				const raw = await getRedis().get(`ba-rate-limit:${key}`);
				return raw ? (JSON.parse(raw) as RateLimit) : undefined;
			},
			// Expire the counters: without a TTL every IP/path pair ever seen
			// stays in Redis forever.
			set: async (key, value) => {
				await getRedis().set(
					`ba-rate-limit:${key}`,
					JSON.stringify(value),
					"EX",
					600,
				);
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
