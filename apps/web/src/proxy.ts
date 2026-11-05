import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth/server";
import {
	isValidTraceId,
	newTraceId,
	TRACE_HEADER,
} from "@/services/logging/trace";

/**
 * The one place that decides who may reach what.
 *
 * Two tiers, deliberately different:
 *
 * - Pages under PROTECTED_PREFIXES get a real session check here, and a
 *   redirect into /login?next=… when there is none. This is an optimistic
 *   gate: it keeps signed-out visitors out of the product shell before any
 *   data is fetched, but it is not the authority.
 * - `/api/*` is not matched at all. A fetch client expects JSON, not a 302,
 *   and every route handler already calls `getSessionUser()` — that is the
 *   authoritative check, and it stays there.
 *
 * Everything not listed is public on purpose: the landing page, the auth
 * pages, and the legal/marketing pages. Keep this list short enough to read.
 */
const PROTECTED_PREFIXES = ["/projects", "/editor", "/settings", "/admin"];

function isProtected(pathname: string): boolean {
	return PROTECTED_PREFIXES.some(
		(prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
	);
}

/**
 * Trace propagation: honour the browser session's id (LogBootstrap sends it
 * on every API call), mint one when absent or malformed, forward it on the
 * downstream request so server renders log under the same id, and mirror it
 * onto the response so `curl -i` / devtools can see it too.
 */
function withTrace(
	request: NextRequest,
	build: (forwardedHeaders: Headers) => NextResponse,
): NextResponse {
	const incoming = request.headers.get(TRACE_HEADER);
	const traceId = isValidTraceId(incoming) ? incoming : newTraceId();
	const forwarded = new Headers(request.headers);
	forwarded.set(TRACE_HEADER, traceId);
	const response = build(forwarded);
	response.headers.set(TRACE_HEADER, traceId);
	return response;
}

export async function proxy(request: NextRequest) {
	const { pathname, search } = request.nextUrl;
	const passThrough = (headers: Headers) =>
		NextResponse.next({ request: { headers } });
	if (!isProtected(pathname)) {
		return withTrace(request, passThrough);
	}

	const session = await auth.api.getSession({ headers: request.headers });
	if (session?.user) {
		return withTrace(request, passThrough);
	}

	const login = new URL("/login", request.url);
	// Built from the request, so untrusted — the login page re-validates it
	// with `safeNextPath()` before navigating. A redirect is the whole
	// response (nothing downstream to forward to), so `headers` goes unused.
	login.searchParams.set("next", `${pathname}${search}`);
	return withTrace(request, () => NextResponse.redirect(login));
}

export const config = {
	matcher: [
		// Skip /api (its handlers guard themselves) and static assets: neither
		// needs the session read, and assets would add a query per file.
		"/((?!api|_next/static|_next/image|favicon.ico|.*\\.[^/]+$).*)",
	],
};
