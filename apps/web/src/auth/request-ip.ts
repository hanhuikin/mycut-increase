/**
 * The client IP as the rate limiter and the audit log should see it.
 *
 * Behind a load balancer `x-forwarded-for` is "<client-supplied value>, <real IP>":
 * anyone can set a fake first entry, so the only value this app may trust is the
 * LAST one — the address our own proxy appended (Nginx should overwrite the
 * header with `$remote_addr`, making it a single entry). Without a proxy the
 * header is absent or holds one address, which is then correct as-is.
 */
export function clientIp({ request }: { request: Request }): string {
	const forwarded = request.headers.get("x-forwarded-for");
	if (!forwarded) return "";
	const entries = forwarded
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	return entries[entries.length - 1] ?? "";
}
