"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/auth/client";
import { authErrorToKey, errorToKey } from "@/auth/error-map";
import { useLocale } from "@/locale/locale-context";
import type { LocaleKey } from "@/locale";
import {
	AuthError,
	AuthField,
	CapsLockPasswordField,
	SubmitButton,
} from "../form-ui";

/** Password strength: 0-3 from length + character variety. */
function passwordStrength(password: string): 0 | 1 | 2 | 3 {
	let score = 0;
	if (password.length >= 10) score += 1;
	if (password.length >= 14) score += 1;
	if (/[^a-zA-Z0-9]/.test(password) && /[0-9]/.test(password)) score += 1;
	return Math.min(score, 3) as 0 | 1 | 2 | 3;
}

export default function SignupPage() {
	const { t } = useLocale();
	const router = useRouter();

	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [agreed, setAgreed] = useState(false);
	const [errorKey, setErrorKey] = useState<LocaleKey | null>(null);
	const [loading, setLoading] = useState(false);

	const strength = passwordStrength(password);
	const strengthColor =
		strength <= 1 ? "bg-destructive" : strength === 2 ? "bg-amber-500" : "bg-emerald-500";

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		setErrorKey(null);

		if (!email.includes("@")) {
			setErrorKey("auth.error.email_invalid");
			return;
		}
		if (password.length < 10) {
			setErrorKey("auth.error.password_short");
			return;
		}
		if (password !== confirm) {
			setErrorKey("auth.error.password_mismatch");
			return;
		}
		if (!agreed) {
			setErrorKey("auth.error.agree_required");
			return;
		}

		setLoading(true);
		try {
			const result = await authClient.signUp.email({
				email: email.trim(),
				password,
				name: name.trim() || email.split("@")[0],
			});
			if (result.error) {
				setErrorKey(authErrorToKey({ code: result.error.code }));
				return;
			}
			router.push("/projects");
		} catch (error) {
			setErrorKey(errorToKey({ error }));
		} finally {
			setLoading(false);
		}
	};

	return (
		<div>
			<h1 className="text-xl font-bold">{t["auth.signup.title"]}</h1>
			<p className="text-muted-foreground mt-1 mb-6 text-xs">
				{t["auth.login.no_account"]}{" "}
				<Link href="/login" className="text-primary hover:underline">
					{t["auth.login.to_login"]}
				</Link>
			</p>

			<form onSubmit={handleSubmit}>
				<AuthField
					label={t["auth.field.name"]}
					value={name}
					onChange={setName}
					placeholder={t["auth.field.name_placeholder"]}
				/>
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
					autoComplete="new-password"
				/>
				{password.length > 0 && (
					<div className="mt-1 mb-3 flex items-center gap-1.5">
						{[0, 1, 2].map((index) => (
							<span
								key={index}
								className={`h-1 flex-1 rounded-full ${
									index < strength ? strengthColor : "bg-border"
								}`}
							/>
						))}
					</div>
				)}
				<AuthField
					label={t["auth.field.confirm_password"]}
					type="password"
					value={confirm}
					onChange={setConfirm}
					autoComplete="new-password"
				/>

				<label className="text-foreground/80 mb-4 mt-1 flex cursor-pointer items-start gap-2 text-xs">
					<input
						type="checkbox"
						checked={agreed}
						onChange={(event) => setAgreed(event.target.checked)}
						className="border-border mt-0.5 size-3.5 rounded"
					/>
					<span>
						{t["auth.login.agree_prefix"]}{" "}
						<Link href="/terms" className="text-primary hover:underline">
							{t["nav.terms"]}
						</Link>{" "}
						&amp;{" "}
						<Link href="/privacy" className="text-primary hover:underline">
							{t["nav.privacy"]}
						</Link>
					</span>
				</label>

				<SubmitButton
					label={t["auth.action.signup"]}
					loadingLabel={t["auth.action.working"]}
					loading={loading}
				/>
				<AuthError errorKey={errorKey} />
			</form>
		</div>
	);
}
