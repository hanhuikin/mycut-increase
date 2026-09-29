"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import type { LocaleKey, LocaleStrings } from "@/locale";
import { useLocale } from "@/locale/locale-context";
import {
	GateErrorView,
	LoadErrorView,
	type GateStatus,
	isGateStatus,
} from "../gate-error-view";

interface AuditEntry {
	id: string;
	actorEmail: string;
	action: string;
	target: string;
	detail: string;
	createdAt: string;
}

interface AuditResponse {
	entries: AuditEntry[];
	total: number;
	actions: string[];
	limit: number;
	offset: number;
}

const ACTION_LABEL_KEY: Record<string, LocaleKey> = {
	elevate: "admin.audit.action_elevate",
	ban: "admin.audit.action_ban",
	unban: "admin.audit.action_unban",
	set_role: "admin.audit.action_set_role",
	set_plan: "admin.audit.action_set_plan",
	adjust_credits: "admin.audit.action_adjust_credits",
	model_update: "admin.audit.action_model_update",
	model_create: "admin.audit.action_model_create",
	provider_update: "admin.audit.action_provider_update",
	channel_create: "admin.audit.action_channel_create",
	channel_update: "admin.audit.action_channel_update",
	channel_delete: "admin.audit.action_channel_delete",
	credential_update: "admin.audit.action_credential_update",
	route_secret_update: "admin.audit.action_route_secret_update",
	route_secret_clear: "admin.audit.action_route_secret_clear",
	redeem_batch: "admin.audit.action_redeem_batch",
};

/** Unknown actions fall back to their raw name rather than showing nothing. */
function actionLabel(t: LocaleStrings, action: string): string {
	const key = ACTION_LABEL_KEY[action];
	return key ? t[key] : action;
}

const PAGE_SIZE = 50;

export default function AdminAuditPage() {
	const { t } = useLocale();
	const [data, setData] = useState<AuditResponse | null>(null);
	const [gateError, setGateError] = useState<GateStatus | null>(null);
	const [loadFailure, setLoadFailure] = useState<string | null>(null);
	const [action, setAction] = useState("");
	const [offset, setOffset] = useState(0);

	const load = useCallback(async (filter: string, nextOffset: number) => {
		const params = new URLSearchParams({
			limit: String(PAGE_SIZE),
			offset: String(nextOffset),
		});
		if (filter) params.set("action", filter);
		const res = await fetch(`/api/admin/audit?${params.toString()}`);
		if (!res.ok) {
			if (isGateStatus(res.status)) {
				setGateError(res.status);
				return;
			}
			setLoadFailure(String(res.status));
			return;
		}
		setLoadFailure(null);
		setData((await res.json()) as AuditResponse);
	}, []);

	useEffect(() => {
		load(action, offset);
	}, [load, action, offset]);

	if (gateError) {
		return <GateErrorView status={gateError} />;
	}
	if (loadFailure) {
		return (
			<LoadErrorView
				status={loadFailure}
				onRetry={() => load(action, offset)}
			/>
		);
	}

	const total = data?.total ?? 0;
	const from = total === 0 ? 0 : offset + 1;
	const to = Math.min(offset + PAGE_SIZE, total);

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-3">
				<select
					value={action}
					onChange={(event) => {
						setAction(event.target.value);
						setOffset(0);
					}}
					className="border-border bg-input focus-visible:border-primary/50 h-7 rounded-md border px-2 text-[13.5px] outline-none"
				>
					<option value="">{t["admin.audit.filter_all"]}</option>
					{(data?.actions ?? []).map((entry) => (
						<option key={entry} value={entry}>
							{actionLabel(t, entry)}
						</option>
					))}
				</select>

				<span className="text-muted-foreground ml-auto font-mono text-[13px]">
					{t["admin.audit.page_range"]
						.replace("{from}", String(from))
						.replace("{to}", String(to))
						.replace("{total}", String(total))}
				</span>
				<Button
					variant="outline"
					size="sm"
					disabled={offset === 0}
					onClick={() => setOffset((current) => Math.max(current - PAGE_SIZE, 0))}
				>
					{t["admin.audit.prev"]}
				</Button>
				<Button
					variant="outline"
					size="sm"
					disabled={to >= total}
					onClick={() => setOffset((current) => current + PAGE_SIZE)}
				>
					{t["admin.audit.next"]}
				</Button>
			</div>

			<div className="bg-card border-border overflow-hidden rounded-xl border">
				<Table className="text-[13.5px]">
					<TableHeader>
						<TableRow>
							{[
								t["admin.audit.col_time"],
								t["admin.audit.col_actor"],
								t["admin.audit.col_action"],
								t["admin.audit.col_target"],
								t["admin.audit.col_detail"],
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
						{data === null ? (
							Array.from({ length: 6 }, (_, index) => (
								<TableRow key={index}>
									<TableCell colSpan={5}>
										<Skeleton className="h-5 w-full" />
									</TableCell>
								</TableRow>
							))
						) : data.entries.length === 0 ? (
							<TableRow>
								<TableCell
									colSpan={5}
									className="text-muted-foreground py-8 text-center"
								>
									{t["admin.users.empty"]}
								</TableCell>
							</TableRow>
						) : (
							data.entries.map((entry) => (
								<TableRow key={entry.id} className="font-mono text-[12.5px]">
									<TableCell className="text-muted-foreground whitespace-nowrap">
										{entry.createdAt.replace("T", " ").slice(0, 19)}
									</TableCell>
									<TableCell className="text-primary">
										{entry.actorEmail}
									</TableCell>
									<TableCell className="font-sans">
										{actionLabel(t, entry.action)}
									</TableCell>
									<TableCell className="text-muted-foreground max-w-40 truncate">
										{entry.target}
									</TableCell>
									<TableCell className="text-muted-foreground max-w-56 truncate">
										{entry.detail}
									</TableCell>
								</TableRow>
							))
						)}
					</TableBody>
				</Table>
			</div>
		</div>
	);
}
