import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth/server";

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

export async function proxy(request: NextRequest) {
	const { pathname, search } = request.nextUrl;
	if (!isProtected(pathname)) {
		return NextResponse.next();
	}

	const session = await auth.api.getSession({ headers: request.headers });
	if (session?.user) {
		return NextResponse.next();
	}

	const login = new URL("/login", request.url);
	// Built from the request, so untrusted — the login page re-validates it
	// with `safeNextPath()` before navigating.
	login.searchParams.set("next", `${pathname}${search}`);
	return NextResponse.redirect(login);
}

export const config = {
	matcher: [
		// Skip /api (its handlers guard themselves) and static assets: neither
		// needs the session read, and assets would add a query per file.
		"/((?!api|_next/static|_next/image|favicon.ico|.*\\.[^/]+$).*)",
	],
};
