import { Redis } from "ioredis";
import { webEnv } from "@/env/web";

let client: Redis | null = null;

/**
 * Shared Redis connection. Lazy so importing this module never opens a socket
 * at build time, and `lazyConnect` so a missing server only surfaces on the
 * first command (callers are written to fail open).
 */
export function getRedis(): Redis {
	if (!client) {
		client = new Redis(webEnv.REDIS_URL, {
			lazyConnect: true,
			maxRetriesPerRequest: 2,
			enableOfflineQueue: false,
		});
		client.on("error", (error) => {
			// Swallow: connection errors are reported per-call by the callers.
			console.warn("Redis error:", error.message);
		});
	}
	return client;
}

/**
 * Sliding-window rate limit over a sorted set: members are request timestamps,
 * old entries are trimmed, the window is counted and the key expires on its
 * own. One round trip, atomic.
 */
const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, member)
  count = count + 1
end
redis.call('PEXPIRE', key, window)
return count
`;

/** Returns true when the request is within the limit. */
export async function consumeRateLimit({
	key,
	limit,
	windowMs,
}: {
	key: string;
	limit: number;
	windowMs: number;
}): Promise<boolean> {
	const redis = getRedis();
	const member = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	const count = (await redis.eval(
		SLIDING_WINDOW_SCRIPT,
		1,
		`rate-limit:${key}`,
		Date.now(),
		windowMs,
		limit,
		member,
	)) as number;
	return count <= limit;
}
