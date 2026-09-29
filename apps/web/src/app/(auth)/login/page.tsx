"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/auth/client";
import { errorToKey } from "@/auth/error-map";
import { safeNextPath } from "@/auth/next-path";
import { useLocale } from "@/locale/locale-context";
import {
	AuthError,
	AuthField,
	CapsLockPasswordField,
	SubmitButton,
} from "../form-ui";

export default function LoginPage() {
	const { t } = useLocale();
	const router = useRouter();

	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [errorKey, setErrorKey] = useState<Parameters<
		typeof AuthError
	>[0]["errorKey"]>(null);
	const [loading, setLoading] = useState(false);

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		setErrorKey(null);
		setLoading(true);
		try {
			const result = await authClient.signIn.email({
				email: email.trim(),
				password,
			});
			if (result.error) {
				setErrorKey(errorToKey({ error: result.error }));
				return;
			}
			// Return to wherever sent us here (the admin panel, usually) rather
			// than always dropping into the editor.
			const next = safeNextPath(
				new URLSearchParams(window.location.search).get("next"),
			);
			router.push(next ?? "/projects");
		} catch (error) {
			setErrorKey(errorToKey({ error }));
		} finally {
			setLoading(false);
		}
	};

	return (
		<div>
			<h1 className="text-xl font-bold">{t["auth.login.title"]}</h1>
			<p className="text-muted-foreground mt-1 mb-6 text-xs">
				{t["auth.login.subtitle_prefix"]}
				<Link href="/signup" className="text-primary hover:underline">
					{t["auth.login.subtitle_link"]}
				</Link>
				{t["auth.login.subtitle_suffix"]}
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
				<CapsLockPasswordField
					label={t["auth.field.password"]}
					value={password}
					onChange={setPassword}
					autoComplete="current-password"
				/>

				<div className="mb-4 mt-1 flex items-center justify-between">
					<label className="text-foreground/80 flex cursor-pointer items-center gap-2 text-xs">
						<input
							type="checkbox"
							defaultChecked
							className="border-border size-3.5 rounded"
						/>
						{t["auth.login.remember"]}
					</label>
					<Link
						href="/forgot"
						className="text-primary hover:underline text-xs"
					>
						{t["auth.login.forgot"]}
					</Link>
				</div>

				<SubmitButton
					label={t["auth.action.login"]}
					loadingLabel={t["auth.action.working"]}
					loading={loading}
				/>
				<AuthError errorKey={errorKey} />
			</form>

			<div className="mt-6 flex items-center text-xs">
				<span className="text-muted-foreground">
					{t["auth.login.agree_suffix"]}{" "}
					<Link href="/terms" className="text-primary hover:underline">
						{t["nav.terms"]}
					</Link>{" "}
					&amp;{" "}
					<Link href="/privacy" className="text-primary hover:underline">
						{t["nav.privacy"]}
					</Link>
				</span>
			</div>
		</div>
	);
}
