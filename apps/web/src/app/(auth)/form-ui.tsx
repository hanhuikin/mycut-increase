"use client";

import { useEffect, useState } from "react";
import { useLocale } from "@/locale/locale-context";
import type { LocaleKey } from "@/locale";

export function AuthField({
	label,
	type = "text",
	value,
	onChange,
	placeholder,
	error,
	autoComplete,
	onKeyDown,
}: {
	label: string;
	type?: "text" | "email" | "password";
	value: string;
	onChange: (value: string) => void;
	placeholder?: string;
	error?: string | null;
	autoComplete?: string;
	onKeyDown?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
	const [showPassword, setShowPassword] = useState(false);
	const { t } = useLocale();
	const isPassword = type === "password";
	const inputType = isPassword && showPassword ? "text" : type;

	return (
		<div className="mb-3.5">
			<label className="text-foreground/80 mb-1.5 block text-xs">{label}</label>
			<div
				className={`border-border bg-background focus-within:border-primary flex h-10 items-center gap-2 rounded-lg border px-3 transition-colors ${
					error ? "border-destructive" : ""
				}`}
			>
				<input
					type={inputType}
					value={value}
					onChange={(event) => onChange(event.target.value)}
					onKeyDown={onKeyDown}
					placeholder={placeholder}
					autoComplete={autoComplete}
					className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
				/>
				{isPassword && (
					<button
						type="button"
						onClick={() => setShowPassword((current) => !current)}
						className="text-muted-foreground hover:text-foreground shrink-0 text-xs"
					>
						{showPassword ? t["ui.hide_password"] : t["ui.show_password"]}
					</button>
				)}
			</div>
			{error ? (
				<p className="text-destructive mt-1.5 text-xs">{error}</p>
			) : null}
		</div>
	);
}

/** Password input with Caps Lock detection shown while focused. */
export function CapsLockPasswordField({
	label,
	value,
	onChange,
	error,
	autoComplete,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	error?: string | null;
	autoComplete?: string;
}) {
	const { t } = useLocale();
	const [capsOn, setCapsOn] = useState(false);

	return (
		<div>
			<div className="mb-1.5 flex items-center justify-between">
				<label className="text-foreground/80 block text-xs">{label}</label>
				{capsOn && (
					<span className="text-xs text-amber-500">{t["auth.capslock"]}</span>
				)}
			</div>
			<AuthField
				label=""
				type="password"
				value={value}
				onChange={onChange}
				error={error}
				autoComplete={autoComplete}
				onKeyDown={(event) =>
					setCapsOn(event.getModifierState?.("CapsLock") ?? false)
				}
			/>
		</div>
	);
}

export function SubmitButton({
	label,
	loading,
	loadingLabel,
	disabled,
}: {
	label: string;
	loading: boolean;
	loadingLabel: string;
	disabled?: boolean;
}) {
	return (
		<button
			type="submit"
			disabled={loading || disabled}
			className="bg-primary text-primary-foreground hover:bg-primary/90 flex h-10 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50"
		>
			{loading && (
				<span className="size-3.5 animate-spin rounded-full border-2 border-current/30 border-t-current" />
			)}
			{loading ? loadingLabel : label}
		</button>
	);
}

/**
 * The session trace id, shown next to auth errors so a user reporting a
 * failed login can hand over the one id that greps their server logs.
 * Language-neutral (`trace_id`) — no locale keys. Click copies it.
 */
function TraceHint() {
	const [traceId, setTraceId] = useState<string | null>(null);
	useEffect(() => {
		setTraceId(window.__TRACE_ID__ ?? null);
	}, []);
	if (!traceId) return null;
	return (
		<button
			type="button"
			onClick={() => void navigator.clipboard?.writeText(traceId)}
			title="Copy trace id"
			className="text-muted-foreground mt-1 block cursor-pointer font-mono text-[11px] hover:underline"
		>
			trace_id: {traceId}
		</button>
	);
}

export function AuthError({ errorKey }: { errorKey: LocaleKey | null }) {
	const { t } = useLocale();
	if (!errorKey) return null;
	return (
		<div aria-live="assertive" className="mt-3">
			<p className="text-destructive text-xs">{t[errorKey]}</p>
			<TraceHint />
		</div>
	);
}
