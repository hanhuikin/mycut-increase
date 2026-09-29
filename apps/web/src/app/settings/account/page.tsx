"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/auth/client";
import { useLocale } from "@/locale/locale-context";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

interface Tx {
	id: string;
	amount: number;
	kind: string;
	note: string;
	createdAt: string;
}

interface Me {
	balance: number;
	plan: string;
	transactions: Tx[];
}

const TX_KEY: Record<string, string> = {
	freeze: "settings.tx_freeze",
	settle: "settings.tx_settle",
	refund: "settings.tx_refund",
	grant: "settings.tx_grant",
	redeem: "settings.tx_redeem",
	adjust: "settings.tx_adjust",
};

export default function AccountSettingsPage() {
	const { t } = useLocale();
	const router = useRouter();
	const { data: session, isPending } = authClient.useSession();

	const [me, setMe] = useState<Me | null>(null);
	const [sessions, setSessions] = useState<
		Array<{
			id: string;
			userAgent: string | null;
			createdAt: Date | null;
		}>
	>([]);
	const [twoFaUri, setTwoFaUri] = useState<string | null>(null);
	const [pwDialogOpen, setPwDialogOpen] = useState(false);

	const loadSessions = useCallback(async () => {
		const result = await authClient.listSessions();
		setSessions((result.data ?? []) as typeof sessions);
	}, []);

	useEffect(() => {
		if (isPending || !session) return;
		(async () => {
			const res = await fetch("/api/billing/me");
			if (res.ok) setMe((await res.json()) as Me);
			await loadSessions();
		})();
	}, [isPending, session, loadSessions]);

	if (isPending) {
		return (
			<Centered>
				<Spinner />
			</Centered>
		);
	}
	if (!session) {
		return (
			<Centered>
				<p className="text-muted-foreground text-sm">{t["admin.error.401"]}</p>
				<Link href="/login" className="text-primary hover:underline text-sm">
					{t["auth.menu.login"]}
				</Link>
			</Centered>
		);
	}

	const user = session.user;

	const handleEnable2Fa = async () => {
		const password = window.prompt(t["settings.twofa_password"]);
		if (!password) return;
		const result = await authClient.twoFactor.enable({ password });
		const uri = (result?.data as { twoFactorURI?: string } | undefined)
			?.twoFactorURI;
		if (uri) {
			setTwoFaUri(uri);
		} else {
			toast.error(t["auth.error.generic"]);
		}
		router.refresh();
	};

	const handleDisable2Fa = async () => {
		const password = window.prompt(t["settings.twofa_password"]);
		if (!password) return;
		await authClient.twoFactor.disable({ password });
		toast.success(t["settings.2fa_disabled_toast"]);
		router.refresh();
	};

	return (
		<div className="bg-background min-h-screen py-10">
			<div className="mx-auto max-w-3xl px-6">
				<div className="mb-6 flex items-center gap-4">
					<div className="bg-primary text-primary-foreground flex size-13 items-center justify-center rounded-full text-xl font-bold">
						{(user.name || user.email || "?").slice(0, 1).toUpperCase()}
					</div>
					<div>
						<h1 className="text-lg font-bold">{user.name}</h1>
						<p className="text-muted-foreground font-mono text-xs">
							{user.email}
						</p>
					</div>
				</div>

				<div className="grid gap-4 md:grid-cols-2">
					<Card title={t["settings.card_credits"]}>
						<Row
							label={t["settings.balance_row"]}
							value={me ? `${me.balance}` : "…"}
						/>
						<Row
							label={t["settings.transactions_row"]}
							value={
								me
									? me.transactions
											.slice(0, 4)
											.map((tx) => `${tx.amount > 0 ? "+" : ""}${tx.amount}`)
											.join(" · ") || "—"
									: "…"
							}
							mono
						/>
					</Card>

					<Card title={t["settings.card_security"]}>
						<Row
							label={t["settings.twofa_row"]}
							value={
								(user as { twoFactorEnabled?: boolean }).twoFactorEnabled
									? t["settings.twofa_on"]
									: t["settings.twofa_off"]
							}
						/>
						<div className="mt-2 flex gap-2">
							{(user as { twoFactorEnabled?: boolean }).twoFactorEnabled ? (
								<Button
									variant="outline"
									size="sm"
									className="h-7 text-xs"
									onClick={handleDisable2Fa}
								>
									{t["settings.twofa_disable"]}
								</Button>
							) : (
								<Button
									variant="outline"
									size="sm"
									className="h-7 text-xs"
									onClick={handleEnable2Fa}
								>
									{t["settings.twofa_enable"]}
								</Button>
							)}
							<Button
								variant="outline"
								size="sm"
								className="h-7 text-xs"
								onClick={() => setPwDialogOpen(true)}
							>
								{t["settings.password_change"]}
							</Button>
						</div>
					</Card>

					<Card title={t["settings.card_sessions"]} className="md:col-span-2">
						{sessions.map((item) => (
							<Row
								key={item.id}
								label={item.userAgent?.slice(0, 48) ?? "—"}
								value={t["settings.session_revoke"]}
								action={async () => {
									await authClient.revokeSession({ token: item.id });
									await loadSessions();
								}}
							/>
						))}
						{sessions.length > 1 && (
							<Button
								variant="ghost"
								size="sm"
								className="text-destructive hover:text-destructive mt-2 h-7 text-xs"
								onClick={async () => {
									await authClient.revokeSessions();
									await loadSessions();
								}}
							>
								{t["settings.sessions_signout_others"]}
							</Button>
						)}
					</Card>
				</div>

				<div className="border-destructive/40 mt-4 rounded-xl border p-4">
					<h2 className="text-destructive mb-2 text-xs font-semibold uppercase tracking-widest">
						{t["settings.danger_title"]}
					</h2>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<p className="text-muted-foreground text-xs">
							{t["settings.danger_desc"]}
						</p>
						<Button
							variant="outline"
							size="sm"
							className="text-destructive border-destructive/40 hover:text-destructive h-8 text-xs"
							onClick={async () => {
								await authClient.deleteUser();
								toast.success(t["settings.danger_action"]);
								router.push("/");
							}}
						>
							{t["settings.danger_action"]}
						</Button>
					</div>
				</div>
			</div>

			<Dialog open={pwDialogOpen} onOpenChange={setPwDialogOpen}>
				<DialogContent className="max-w-sm">
					<DialogTitle>{t["settings.password_change"]}</DialogTitle>
					<ChangePasswordForm
						onDone={() => {
							setPwDialogOpen(false);
							toast.success(t["settings.password_done"]);
						}}
					/>
				</DialogContent>
			</Dialog>

			<Dialog open={twoFaUri !== null} onOpenChange={() => setTwoFaUri(null)}>
				<DialogContent className="max-w-md">
					<DialogTitle>{t["settings.twofa_enable"]}</DialogTitle>
					<p className="text-muted-foreground text-xs">
						{t["settings.twofa_uri_hint"]}
					</p>
					<code className="bg-muted block overflow-x-auto rounded-md p-3 font-mono text-xs break-all">
						{twoFaUri}
					</code>
					<Button
						size="sm"
						className="h-8 text-xs"
						onClick={() => {
							if (twoFaUri) navigator.clipboard.writeText(twoFaUri);
						}}
					>
						{t["common.copy"]}
					</Button>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function ChangePasswordForm({ onDone }: { onDone: () => void }) {
	const { t } = useLocale();
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [error, setError] = useState<string | null>(null);

	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={async (event) => {
				event.preventDefault();
				setError(null);
				if (next.length < 10) {
					setError(t["auth.error.password_short"]);
					return;
				}
				const result = await authClient.changePassword({
					currentPassword: current,
					newPassword: next,
					revokeOtherSessions: true,
				});
				if (result.error) {
					setError(t["auth.error.bad_credentials"]);
					return;
				}
				onDone();
			}}
		>
			<input
				type="password"
				value={current}
				onChange={(event) => setCurrent(event.target.value)}
				placeholder={t["settings.password_current"]}
				className="border-border focus-within:border-primary h-9 rounded-lg border bg-transparent px-3 text-sm outline-none"
			/>
			<input
				type="password"
				value={next}
				onChange={(event) => setNext(event.target.value)}
				placeholder={t["settings.password_new"]}
				className="border-border focus-within:border-primary h-9 rounded-lg border bg-transparent px-3 text-sm outline-none"
			/>
			{error && <p className="text-destructive text-xs">{error}</p>}
			<Button type="submit" size="sm" className="h-9 text-xs">
				{t["settings.password_change"]}
			</Button>
		</form>
	);
}

function Centered({ children }: { children: React.ReactNode }) {
	return (
		<div className="bg-background flex min-h-screen flex-col items-center justify-center gap-3">
			{children}
		</div>
	);
}

function Spinner() {
	return (
		<div className="border-primary size-7 animate-spin rounded-full border-2 border-t-transparent" />
	);
}

function Card({
	title,
	children,
	className = "",
}: {
	title: string;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<div className={`bg-card border-border rounded-xl border p-4 ${className}`}>
			<h2 className="text-muted-foreground mb-2 text-[10px] font-semibold uppercase tracking-[0.16em]">
				{title}
			</h2>
			{children}
		</div>
	);
}

function Row({
	label,
	value,
	mono = false,
	action,
}: {
	label: string;
	value: string;
	mono?: boolean;
	action?: () => void;
}) {
	return (
		<div className="border-border/60 flex items-center justify-between gap-3 border-b py-1.5 text-xs last:border-0">
			<span className="text-muted-foreground truncate">{label}</span>
			{action ? (
				<button
					type="button"
					onClick={action}
					className="text-destructive shrink-0 hover:underline"
				>
					{value}
				</button>
			) : (
				<span className={`shrink-0 ${mono ? "font-mono" : ""} text-foreground`}>
					{value}
				</span>
			)}
		</div>
	);
}
