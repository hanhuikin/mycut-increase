"use client";

import { useState } from "react";
import Link from "next/link";
import { authClient } from "@/auth/client";
import { errorToKey } from "@/auth/error-map";
import { useLocale } from "@/locale/locale-context";
import { AuthError, AuthField, SubmitButton } from "../form-ui";

export default function ForgotPage() {
	const { t } = useLocale();
	const [email, setEmail] = useState("");
	const [sent, setSent] = useState(false);
	const [errorKey, setErrorKey] = useState<
		Parameters<typeof AuthError>[0]["errorKey"]
	>(null);
	const [loading, setLoading] = useState(false);

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		setErrorKey(null);
		setLoading(true);
		try {
			// The response is intentionally identical whether or not the email
			// exists — the page must not become an account-existence oracle.
			await authClient.requestPasswordReset({
				email: email.trim(),
				redirectTo: `${window.location.origin}/reset`,
			});
			setSent(true);
		} catch (error) {
			setErrorKey(errorToKey({ error }));
		} finally {
			setLoading(false);
		}
	};

	if (sent) {
		return (
			<div>
				<h1 className="text-xl font-bold">{t["auth.forgot.title"]}</h1>
				<p className="text-foreground/90 mt-4 text-sm">
					{t["auth.forgot.sent"]}
				</p>
				<p className="text-muted-foreground mt-2 text-xs">
					{t["auth.forgot.expires"]}{" "}
					<button
						type="button"
						onClick={() => setSent(false)}
						className="text-primary hover:underline"
					>
						{t["auth.forgot.resend"]}
					</button>
				</p>
				<Link
					href="/login"
					className="text-primary hover:underline mt-6 inline-block text-xs"
				>
					{t["auth.login.to_login"]}
				</Link>
			</div>
		);
	}

	return (
		<div>
			<h1 className="text-xl font-bold">{t["auth.forgot.title"]}</h1>
			<p className="text-muted-foreground mt-1 mb-6 text-xs">
				{t["auth.field.email"]}
			</p>
			<form onSubmit={handleSubmit}>
				<AuthField
					label={t["auth.field.email"]}
					type="email"
					value={email}
					onChange={setEmail}
					placeholder="you@example.com"
					autoComplete="email"
				/>
				<SubmitButton
					label={t["auth.action.send_reset_link"]}
					loadingLabel={t["auth.action.working"]}
					loading={loading}
				/>
				<AuthError errorKey={errorKey} />
			</form>
		</div>
	);
}
