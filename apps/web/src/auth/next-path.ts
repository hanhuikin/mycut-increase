/**
 * A `next` query param is a redirect target chosen by whoever built the link,
 * so it is untrusted input. Only same-origin absolute *paths* are accepted:
 * `//evil.com` and `https://evil.com` are protocol-relative or absolute URLs,
 * not paths, and would turn the login page into an open redirect.
 */
export function safeNextPath(value: string | null | undefined): string | null {
	if (!value) return null;
	if (!value.startsWith("/")) return null;
	if (value.startsWith("//")) return null;
	if (value.startsWith("/\\")) return null;
	return value;
}
