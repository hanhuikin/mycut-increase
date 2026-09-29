"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/auth/client";
import { safeNextPath } from "@/auth/next-path";
import { useLocale } from "@/locale/locale-context";
import { GATE_STORAGE_KEY } from "../layout";

/** Step-up gate: password (+ TOTP when 2FA is on) issues the 30-minute cookie. */
export default function AdminEnterPage() {
	const { t } = useLocale();
	const router = useRouter();
	const { data: session } = authClient.useSession();

	const [password, setPassword] = useState("");
	const [totp, setTotp] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);

	const twoFactorEnabled =
		(session?.user as { twoFactorEnabled?: boolean } | undefined)
			?.twoFactorEnabled === true;

	const handleSubmit = async (event: React.FormEvent) => {
		event.preventDefault();
		setError(null);
		setLoading(true);
		try {
			const res = await fetch("/api/admin/elevate", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ password, totp: totp || undefined }),
			});
			if (res.ok) {
				sessionStorage.setItem(
					GATE_STORAGE_KEY,
					String(Date.now() + 30 * 60 * 1000),
				);
				// Back to the page that needed elevation, not always the users list.
				router.push(
					safeNextPath(
						new URLSearchParams(window.location.search).get("next"),
					) ?? "/admin/users",
				);
				return;
			}
			const body = (await res.json()) as { error?: string };
			setError(
				body.error === "bad_credentials"
					? t["auth.error.bad_credentials"]
					: body.error === "totp_required" || body.error === "totp_invalid"
						? t["admin.gate.totp_hint"]
						: body.error === "forbidden"
							? t["admin.error.403"]
							: t["auth.error.generic"],
			);
		} catch {
			setError(t["auth.error.network"]);
		} finally {
			setLoading(false);
		}
	};

	return (
		<div className="mx-auto max-w-sm pt-10">
			<span className="border-primary/50 text-primary mb-4 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[13.5px]">
				{t["admin.gate.badge"]}
			</span>
			<h1 className="text-[19px] font-bold">{t["admin.gate.title"]}</h1>
			<p className="text-muted-foreground mt-1 mb-6 text-[13.5px]">
				{t["admin.gate.subtitle"]}
			</p>

			<form onSubmit={handleSubmit} className="flex flex-col">
				<Label className="text-foreground/80 mb-1.5" htmlFor="admin-gate-password">
					{t["admin.gate.password"]}
				</Label>
				<Input
					id="admin-gate-password"
					type="password"
					size="lg"
					value={password}
					onChange={(event) => setPassword(event.target.value)}
					autoComplete="current-password"
					className="mb-3.5"
				/>

				{twoFactorEnabled && (
					<>
						<Label className="text-foreground/80 mb-1.5" htmlFor="admin-gate-totp">
							{t["admin.gate.totp"]}
						</Label>
						<Input
							id="admin-gate-totp"
							type="text"
							inputMode="numeric"
							size="lg"
							value={totp}
							onChange={(event) =>
								setTotp(event.target.value.replace(/\D/g, "").slice(0, 6))
							}
							placeholder="000000"
							className="mb-2 font-mono text-[19px] tracking-[0.4em]"
						/>
						<p className="text-muted-foreground mb-3 text-[13.5px]">
							{t["admin.gate.totp_hint"]}
						</p>
					</>
				)}

				<Button
					type="submit"
					disabled={loading || !password}
					size="lg"
					className="bg-primary text-primary-foreground hover:bg-primary/90 w-full font-semibold"
				>
					{loading ? t["auth.action.working"] : t["admin.gate.submit"]}
				</Button>
				{error && <p className="text-destructive mt-3 text-[13.5px]">{error}</p>}
				<p className="text-muted-foreground mt-4 text-[13.5px]">
					{t["admin.gate.expires_in"].replace("{count}", "30")}
				</p>
			</form>
		</div>
	);
}
