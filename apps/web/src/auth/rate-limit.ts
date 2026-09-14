import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { webEnv } from "@/env/web";

const redis = new Redis({
	url: webEnv.UPSTASH_REDIS_REST_URL,
	token: webEnv.UPSTASH_REDIS_REST_TOKEN,
});

export const baseRateLimit = new Ratelimit({
	redis,
	limiter: Ratelimit.slidingWindow(100, "1 m"), // 100 requests per minute
	analytics: true,
	prefix: "rate-limit",
});

export async function checkRateLimit({ request }: { request: Request }) {
	const ip = request.headers.get("x-forwarded-for") ?? "anonymous";

	try {
		const { success } = await baseRateLimit.limit(ip);
		return { success, limited: !success };
	} catch (error) {
		// Fail open: an unreachable limiter must not take the route down with it.
		// Trade-off: requests go unthrottled while the backend is unavailable.
		console.warn(
			"Rate limit backend unavailable, allowing request:",
			error instanceof Error ? error.message : error,
		);
		return { success: true, limited: false };
	}
}
