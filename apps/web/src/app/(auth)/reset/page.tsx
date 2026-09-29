"use client";

import { useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { authClient } from "@/auth/client";
import { errorToKey } from "@/auth/error-map";
import { useLocale } from "@/locale/locale-context";
import {
	AuthError,
	CapsLockPasswordField,
	SubmitButton,
} from "../form-ui";

export default function ResetPage() {
	const { t } = useLocale();
	const searchParams = useSearchParams();
	const token = searchParams.get("token") ?? "";

	const [password, setPassword] = useState("");
	const [done, setDone] = useState(false);
	const [errorKey, setErrorKey] = useState<
		Parameters<typeof AuthError>[0]["errorKey"]
	>(null);
	const [loading, setLoading] = useState(false);

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		setErrorKey(null);
		if (password.length < 10) {
			setErrorKey("auth.error.password_short");
			return;
		}
		setLoading(true);
		try {
			const result = await authClient.resetPassword({
				newPassword: password,
				token,
			});
			if (result.error) {
				setErrorKey("auth.error.reset_link_invalid");
				return;
			}
			setDone(true);
		} catch (error) {
			setErrorKey(errorToKey({ error }));
		} finally {
			setLoading(false);
		}
	};

	if (done) {
		return (
			<div>
				<h1 className="text-xl font-bold">{t["auth.reset.title"]}</h1>
				<p className="text-foreground/90 mt-4 text-sm">{t["auth.reset.done"]}</p>
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
			<h1 className="text-xl font-bold">{t["auth.reset.title"]}</h1>
			<form onSubmit={handleSubmit} className="mt-6">
				<CapsLockPasswordField
					label={t["auth.reset.new_password"]}
					value={password}
					onChange={setPassword}
					autoComplete="new-password"
				/>
				<SubmitButton
					label={t["auth.action.reset_password"]}
					loadingLabel={t["auth.action.working"]}
					loading={loading}
				/>
				<AuthError errorKey={errorKey} />
			</form>
		</div>
	);
}
