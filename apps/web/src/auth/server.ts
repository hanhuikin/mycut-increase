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
	trustedOrigins: [webEnv.NEXT_PUBLIC_SITE_URL],
});

export type Auth = typeof auth;

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
