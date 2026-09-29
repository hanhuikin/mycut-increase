import type { LocaleKey } from "@/locale";

/**
 * Maps better-auth error codes onto locale keys. Codes not listed here fall
 * back to the generic message — unknown server errors never leak to the UI.
 */
export function authErrorToKey({ code }: { code?: string | null }): LocaleKey {
	switch (code) {
		case "INVALID_EMAIL_OR_PASSWORD":
			return "auth.error.bad_credentials";
		case "USER_ALREADY_EXISTS":
		case "USER_EMAIL_ALREADY_EXISTS":
			return "auth.error.user_exists";
		case "PASSWORD_TOO_SHORT":
			return "auth.error.password_short";
		case "PASSWORD_COMPROMISED":
			return "auth.error.breached";
		case "INVALID_EMAIL":
			return "auth.error.email_invalid";
		case "FAILED_TO_CREATE_USER":
		case "FAILED_TO_CREATE_SESSION":
			return "auth.error.generic";
		default:
			return "auth.error.generic";
	}
}

/** Network-layer failures surface as fetch errors without a code. */
export function errorToKey({ error }: { error: unknown }): LocaleKey {
	if (error instanceof TypeError) {
		return "auth.error.network";
	}
	const code = (error as { code?: string } | null)?.code;
	if (code) {
		return authErrorToKey({ code });
	}
	const status = (error as { status?: number } | null)?.status;
	if (status === 429) {
		return "auth.error.429";
	}
	return "auth.error.generic";
}
