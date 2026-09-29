"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type { LocaleKey } from "@/locale";
import { useLocale } from "@/locale/locale-context";
import {
	GateErrorView,
	LoadErrorView,
	type GateStatus,
	isGateStatus,
} from "../gate-error-view";

interface AdminUserRow {
	id: string;
	email: string;
	name: string;
	role: string;
	plan: string;
	banned: boolean;
	twoFactorEnabled: boolean;
	createdAt: string;
}

type ActionKind = "ban" | "unban" | "set_role" | "set_plan";

/** Actions that change what a user can do, and so ask first. */
type Pending = { kind: ActionKind; row: AdminUserRow } | null;

export default function AdminUsersPage() {
	const { t } = useLocale();
	const [rows, setRows] = useState<AdminUserRow[] | null>(null);
	const [gateError, setGateError] = useState<GateStatus | null>(null);
	const [loadFailure, setLoadFailure] = useState<string | null>(null);
	const [search, setSearch] = useState("");
	const [pending, setPending] = useState<Pending>(null);
	const [banReason, setBanReason] = useState("");

	const load = useCallback(async (query: string) => {
		const res = await fetch(
			`/api/admin/users${query ? `?q=${encodeURIComponent(query)}` : ""}`,
		);
		if (!res.ok) {
			if (isGateStatus(res.status)) {
				setGateError(res.status);
				return;
			}
			setLoadFailure(String(res.status));
			return;
		}
		setLoadFailure(null);
		setGateError(null);
		const body = (await res.json()) as { users: AdminUserRow[] };
		setRows(body.users);
	}, []);

	useEffect(() => {
		load("");
	}, [load]);

	const runAction = async (
		row: AdminUserRow,
		action: ActionKind,
		extra: Record<string, string> = {},
	): Promise<void> => {
		const res = await fetch("/api/admin/users", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ userId: row.id, action, ...extra }),
		});
		if (!res.ok) {
			const body = (await res.json()) as { error?: string };
			const selfBlocked: LocaleKey = "admin.users.cannot_modify_self";
			toast.error(
				body.error === "cannot modify your own account this way"
					? t[selfBlocked]
					: t["auth.error.generic"],
			);
			return;
		}
		await load(search);
	};

	const request = (row: AdminUserRow, kind: ActionKind) => {
		if (kind === "unban") {
			runAction(row, "unban");
			return;
		}
		if (kind === "ban") {
			setBanReason("");
		}
		setPending({ kind, row });
	};

	const confirm = async () => {
		if (!pending) return;
		const { kind, row } = pending;
		setPending(null);
		if (kind === "ban") {
			await runAction(row, "ban", { reason: banReason });
			return;
		}
		if (kind === "set_role") {
			await runAction(row, "set_role", {
				role: row.role === "admin" ? "user" : "admin",
			});
			return;
		}
		await runAction(row, "set_plan", {
			plan: row.plan === "pro" ? "free" : "pro",
		});
	};

	const dialog = (() => {
		if (!pending) return null;
		const { kind, row } = pending;
		if (kind === "ban") {
			return {
				title: t["admin.users.confirm_ban_title"],
				body: t["admin.users.confirm_ban_body"],
			};
		}
		if (kind === "set_role") {
			return {
				title: t["admin.users.confirm_role_title"],
				body: t["admin.users.confirm_role_body"],
			};
		}
		return {
			title: t["admin.users.confirm_plan_title"],
			body: t["admin.users.confirm_plan_body"],
		};
	})();

	if (gateError) {
		return <GateErrorView status={gateError} />;
	}
	if (loadFailure) {
		return <LoadErrorView status={loadFailure} onRetry={() => load(search)} />;
	}

	return (
		<div className="flex flex-col gap-4">
			<Input
				value={search}
				onChange={(event) => {
					setSearch(event.target.value);
					load(event.target.value);
				}}
				placeholder={t["admin.users.search"]}
				size="sm"
				className="max-w-sm"
			/>

			<div className="bg-card border-border overflow-hidden rounded-xl border">
				<Table className="text-[13.5px]">
					<TableHeader>
						<TableRow>
							{[
								t["admin.users.col_user"],
								t["admin.users.col_created"],
								t["admin.users.col_role"],
								t["admin.users.col_status"],
								t["admin.users.col_actions"],
							].map((header) => (
								<TableHead
									key={header}
									className="text-[12.5px] tracking-widest uppercase"
								>
									{header}
								</TableHead>
							))}
						</TableRow>
					</TableHeader>
					<TableBody>
						{rows === null ? (
							Array.from({ length: 5 }, (_, index) => (
								<TableRow key={index}>
									<TableCell colSpan={5}>
										<Skeleton className="h-5 w-full" />
									</TableCell>
								</TableRow>
							))
						) : rows.length === 0 ? (
							<TableRow>
								<TableCell
									colSpan={5}
									className="text-muted-foreground py-8 text-center"
								>
									{t["admin.users.empty"]}
								</TableCell>
							</TableRow>
						) : (
							rows.map((row) => (
								<TableRow key={row.id}>
									<TableCell>
										<div>{row.email}</div>
										<div className="text-muted-foreground text-[12.5px]">
											{row.name}
										</div>
									</TableCell>
									<TableCell className="text-muted-foreground font-mono text-[12.5px]">
										{row.createdAt.slice(0, 10)}
									</TableCell>
									<TableCell>
										<RolePill
											label={
												row.role === "admin"
													? t["admin.users.role_admin"]
													: t["admin.users.role_user"]
											}
											admin={row.role === "admin"}
										/>
										<RolePill
											label={
												row.plan === "pro"
													? t["admin.users.plan_pro"]
													: t["admin.users.plan_free"]
											}
											admin={false}
										/>
									</TableCell>
									<TableCell>
										{row.banned ? (
											<span className="text-destructive inline-flex items-center gap-1.5">
												<span className="bg-destructive size-1.5 rounded-full" />
												{t["admin.users.status_banned"]}
											</span>
										) : (
											<span className="text-constructive inline-flex items-center gap-1.5">
												<span className="bg-constructive size-1.5 rounded-full" />
												{t["admin.users.status_active"]}
											</span>
										)}
									</TableCell>
									<TableCell>
										<div className="flex flex-wrap items-center gap-3">
											<Button
												variant="link"
												size="sm"
												className={`h-auto p-0 text-[13.5px] ${row.banned ? "" : "text-destructive"}`}
												onClick={() =>
													request(row, row.banned ? "unban" : "ban")
												}
											>
												{row.banned
													? t["admin.users.action_unban"]
													: t["admin.users.action_ban"]}
											</Button>
											<Button
												variant="link"
												size="sm"
												className="h-auto p-0 text-[13.5px]"
												onClick={() => request(row, "set_role")}
											>
												{row.role === "admin"
													? t["admin.users.action_set_role_user"]
													: t["admin.users.action_set_role_admin"]}
											</Button>
											<Button
												variant="link"
												size="sm"
												className="h-auto p-0 text-[13.5px]"
												onClick={() => request(row, "set_plan")}
											>
												{row.plan === "pro"
													? t["admin.users.action_set_plan_free"]
													: t["admin.users.action_set_plan_pro"]}
											</Button>
										</div>
									</TableCell>
								</TableRow>
							))
						)}
					</TableBody>
				</Table>
			</div>

			<AlertDialog
				open={pending !== null}
				onOpenChange={(open) => {
					if (!open) setPending(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{dialog?.title}</AlertDialogTitle>
						<AlertDialogDescription>{dialog?.body}</AlertDialogDescription>
					</AlertDialogHeader>
					{pending?.kind === "ban" && (
						<Input
							value={banReason}
							onChange={(event) => setBanReason(event.target.value)}
							placeholder={t["admin.users.ban_reason"]}
							size="sm"
						/>
					)}
					<AlertDialogFooter>
						<AlertDialogCancel>
							{t["admin.users.confirm_cancel"]}
						</AlertDialogCancel>
						<AlertDialogAction onClick={confirm}>
							{t["admin.users.confirm_submit"]}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}

function RolePill({ label, admin }: { label: string; admin: boolean }) {
	return (
		<span
			className={`mr-1 inline-block rounded-full border px-2 py-0.5 font-mono text-[11.5px] ${
				admin
					? "border-primary/50 bg-primary/10 text-primary"
					: "border-border text-muted-foreground"
			}`}
		>
			{label}
		</span>
	);
}
