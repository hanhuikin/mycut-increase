import { clientIp } from "@/auth/request-ip";
import { consumeRateLimit } from "@/services/redis";

const WINDOW_MS = 60_000;
const LIMIT = 100; // requests per minute

export async function checkRateLimit({ request }: { request: Request }) {
	const ip = clientIp({ request }) || "anonymous";

	try {
		const allowed = await consumeRateLimit({
			key: ip,
			limit: LIMIT,
			windowMs: WINDOW_MS,
		});
		return { success: allowed, limited: !allowed };
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
