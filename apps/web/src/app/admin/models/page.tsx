"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
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
import { ModelDrawer, type ModelDetail } from "./model-drawer";

const KIND_LABEL_KEY: Record<string, LocaleKey> = {
	video: "admin.models.kind_video",
	tool: "admin.models.kind_tool",
	audio: "admin.models.kind_audio",
	local: "admin.models.kind_local",
};

/**
 * A model can't run when no channel can serve it. Local models (browser
 * transcription) are never routed, so they are exempt.
 */
function isUnrunnable(model: ModelDetail): boolean {
	if (model.kind === "local") return false;
	return !(model.channels ?? []).some((entry) => entry.usable);
}

function priceLabel(model: ModelDetail, t: LocaleStrings): string {
	if (model.kind === "local") {
		return t["admin.models.local_free"];
	}
	if (model.pricePerCall != null) {
		return t["admin.models.price_per_call"].replace(
			"{count}",
			String(model.pricePerCall),
		);
	}
	const parts: string[] = [];
	for (const [resolution, price] of [
		["720p", model.pricePerSecond720],
		["1080p", model.pricePerSecond1080],
	] as const) {
		if (price != null) {
			parts.push(
				`${resolution} ${t["admin.models.price_per_second"].replace("{count}", String(price))}`,
			);
		}
	}
	return parts.length > 0 ? parts.join(" · ") : t["admin.models.route_none"];
}

/**
 * The model registry. Quick on/off switches live here; every other field —
 * including each route's endpoint and API key — is edited in the drawer.
 * There is no create action: the model set is fixed.
 */
export default function AdminModelsPage() {
	const { t } = useLocale();
	const [models, setModels] = useState<ModelDetail[] | null>(null);
	const [gateError, setGateError] = useState<GateStatus | null>(null);
	const [loadFailure, setLoadFailure] = useState<string | null>(null);
	const [openModelId, setOpenModelId] = useState<string | null>(null);
	const [onlyIssues, setOnlyIssues] = useState(false);

	const load = useCallback(async () => {
		const res = await fetch("/api/admin/models");
		if (!res.ok) {
			if (isGateStatus(res.status)) {
				setGateError(res.status);
				return;
			}
			setLoadFailure(String(res.status));
			return;
		}
		setLoadFailure(null);
		const body = (await res.json()) as { models: ModelDetail[] };
		setModels(body.models);
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const summary = useMemo(() => {
		const rows = models ?? [];
		return {
			total: rows.length,
			enabled: rows.filter((model) => model.enabled).length,
			issues: rows.filter(isUnrunnable).length,
		};
	}, [models]);

	const visible = useMemo(() => {
		const rows = models ?? [];
		return onlyIssues ? rows.filter(isUnrunnable) : rows;
	}, [models, onlyIssues]);

	const toggle = async (
		model: ModelDetail,
		patch: { enabled?: boolean; requiresPro?: boolean },
	) => {
		const res = await fetch(
			`/api/admin/models/${encodeURIComponent(model.id)}`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(patch),
			},
		);
		if (!res.ok) {
			if (res.status === 401 || res.status === 403 || res.status === 428) {
				setGateError(String(res.status) as GateStatus);
				return;
			}
			toast.error(t["admin.models.save_failed"]);
			return;
		}
		toast.success(`${model.label} · ${t["admin.models.saved"]}`);
		await load();
	};

	const [createOpen, setCreateOpen] = useState(false);
	const [draftId, setDraftId] = useState("");
	const [draftLabel, setDraftLabel] = useState("");
	const [draftKind, setDraftKind] = useState("video");
	const [creating, setCreating] = useState(false);
	const [createError, setCreateError] = useState<string | null>(null);

	/** Create takes only the identity — routes and keys come next, in the drawer. */
	const submitCreate = async () => {
		setCreating(true);
		setCreateError(null);
		try {
			const res = await fetch("/api/admin/models", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					id: draftId,
					label: draftLabel,
					kind: draftKind,
				}),
			});
			if (!res.ok) {
				if (isGateStatus(res.status)) {
					setGateError(res.status);
					return;
				}
				const body = (await res.json().catch(() => null)) as {
					error?: string;
				} | null;
				setCreateError(
					body?.error === "id_taken"
						? t["admin.models.id_taken"]
						: body?.error === "invalid_id"
							? t["admin.models.id_invalid"]
							: t["admin.models.save_failed"],
				);
				return;
			}
			const body = (await res.json()) as { model: ModelDetail };
			toast.success(t["admin.models.created"]);
			setCreateOpen(false);
			setDraftId("");
			setDraftLabel("");
			setDraftKind("video");
			await load();
			// Straight into the drawer: a model with no route cannot run yet.
			setOpenModelId(body.model.id);
		} finally {
			setCreating(false);
		}
	};

	if (gateError) {
		return <GateErrorView status={gateError} />;
	}
	if (loadFailure) {
		return <LoadErrorView status={loadFailure} onRetry={load} />;
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-center gap-3">
				{models === null ? (
					<Skeleton className="h-4 w-64" />
				) : (
					<p className="text-muted-foreground text-[13.5px]">
						{t["admin.models.summary"]
							.replace("{total}", String(summary.total))
							.replace("{enabled}", String(summary.enabled))
							.replace("{issues}", String(summary.issues))}
					</p>
				)}
				{summary.issues > 0 && (
					<Button
						variant="link"
						size="sm"
						className="ml-auto h-auto p-0 text-[13.5px]"
						onClick={() => setOnlyIssues((current) => !current)}
					>
						{onlyIssues
							? t["admin.models.filter_all"]
							: t["admin.models.filter_issues"]}
					</Button>
				)}
				<Button
					variant="outline"
					size="sm"
					className={summary.issues > 0 ? "" : "ml-auto"}
					onClick={() => {
						setCreateError(null);
						setCreateOpen(true);
					}}
				>
					{t["admin.models.create"]}
				</Button>
			</div>

			<div className="bg-card border-border overflow-hidden rounded-xl border">
				<Table className="text-[13.5px]">
					<TableHeader>
						<TableRow>
							<TableHead>{t["admin.models.col_model"]}</TableHead>
							<TableHead>{t["admin.models.col_kind"]}</TableHead>
							<TableHead>{t["admin.models.channels"]}</TableHead>
							<TableHead>{t["admin.models.col_price"]}</TableHead>
							<TableHead>{t["admin.models.col_status"]}</TableHead>
							<TableHead className="text-right" />
						</TableRow>
					</TableHeader>
					<TableBody>
						{models === null ? (
							Array.from({ length: 5 }, (_, index) => (
								<TableRow key={index}>
									<TableCell colSpan={6}>
										<Skeleton className="h-5 w-full" />
									</TableCell>
								</TableRow>
							))
						) : visible.length === 0 ? (
							<TableRow>
								<TableCell
									colSpan={6}
									className="text-muted-foreground py-8 text-center"
								>
									{onlyIssues
										? t["admin.models.filter_all"]
										: t["admin.models.loading"]}
								</TableCell>
							</TableRow>
						) : (
							visible.map((model) => {
								const broken = isUnrunnable(model);
								return (
									<TableRow key={model.id}>
										<TableCell>
											<div className="font-semibold">{model.label}</div>
											<div className="text-muted-foreground font-mono text-[12px]">
												{model.id}
											</div>
										</TableCell>
										<TableCell className="text-muted-foreground">
											{t[KIND_LABEL_KEY[model.kind] ?? "admin.models.kind_video"]}
										</TableCell>
										<TableCell>
											{model.channels.length === 0 ? (
												<span className="text-muted-foreground font-mono text-[12.5px]">
													{t["admin.models.route_none"]}
												</span>
											) : (
												<div className="flex flex-wrap items-center gap-1">
													{model.channels.map((entry) => (
														<span
															key={entry.channelId}
															className={
																entry.usable
																	? "border-primary/50 text-primary inline-block rounded-full border px-2 py-0.5 font-mono text-[12px]"
																	: "border-border text-muted-foreground inline-block rounded-full border px-2 py-0.5 font-mono text-[12px]"
															}
														>
															{entry.name}
														</span>
													))}
													{broken && (
														<span className="border-caution/55 text-caution inline-block rounded-full border px-2 py-0.5 font-mono text-[12px]">
															{t["admin.models.no_channels"]}
														</span>
													)}
												</div>
											)}
										</TableCell>
										<TableCell className="text-muted-foreground font-mono text-[13px]">
											{priceLabel(model, t)}
										</TableCell>
										<TableCell>
											<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
												<label className="flex cursor-pointer items-center gap-1.5">
													<Switch
														checked={model.enabled}
														onCheckedChange={(enabled) =>
															toggle(model, { enabled })
														}
													/>
													<span
														className={
															model.enabled
																? "text-constructive"
																: "text-muted-foreground"
														}
													>
														{model.enabled
															? t["admin.models.enabled"]
															: t["admin.models.disabled"]}
													</span>
												</label>
												{model.kind !== "local" && (
													<label className="flex cursor-pointer items-center gap-1.5">
														<Switch
															checked={model.requiresPro}
															onCheckedChange={(requiresPro) =>
																toggle(model, { requiresPro })
															}
														/>
														<span className="text-muted-foreground">
															{t["admin.models.pro_tag"]}
														</span>
													</label>
												)}
											</div>
										</TableCell>
										<TableCell className="text-right">
											<Button
												variant="outline"
												size="sm"
												onClick={() => setOpenModelId(model.id)}
											>
												{t["admin.models.edit"]}
											</Button>
										</TableCell>
									</TableRow>
								);
							})
						)}
					</TableBody>
				</Table>
			</div>

			<ModelDrawer
				modelId={openModelId}
				onClose={() => setOpenModelId(null)}
				onSaved={load}
				onGate={setGateError}
			/>

			<Dialog
				open={createOpen}
				onOpenChange={(open) => {
					if (!open) setCreateOpen(false);
				}}
			>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>{t["admin.models.create_title"]}</DialogTitle>
						<DialogDescription>
							{t["admin.models.create_hint"]}
						</DialogDescription>
					</DialogHeader>
					<DialogBody className="flex flex-col gap-3">
						<Field label={t["admin.models.model_id"]}>
							<Input
								value={draftId}
								onChange={(event) =>
									setDraftId(event.target.value.trim().toLowerCase())
								}
								size="sm"
								className="font-mono"
								placeholder="my-model"
								autoComplete="off"
							/>
						</Field>
						<Field label={t["admin.models.label"]}>
							<Input
								value={draftLabel}
								onChange={(event) => setDraftLabel(event.target.value)}
								size="sm"
							/>
						</Field>
						<Field label={t["admin.models.col_kind"]}>
							<select
								value={draftKind}
								onChange={(event) => setDraftKind(event.target.value)}
								className="border-border bg-input focus-visible:border-primary/50 h-7 rounded-md border px-2 font-mono text-[13px] outline-none"
							>
								{["video", "tool", "audio", "local"].map((kind) => (
									<option key={kind} value={kind}>
										{t[KIND_LABEL_KEY[kind] ?? "admin.models.kind_video"]}
									</option>
								))}
							</select>
						</Field>
						{createError && (
							<p className="text-destructive text-[13px]">{createError}</p>
						)}
					</DialogBody>
					<DialogFooter>
						<Button
							variant="outline"
							size="sm"
							onClick={() => setCreateOpen(false)}
						>
							{t["admin.models.create_cancel"]}
						</Button>
						<Button
							size="sm"
							disabled={creating || !draftId.trim() || !draftLabel.trim()}
							onClick={submitCreate}
						>
							{t["admin.models.create_submit"]}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

/** Label + control, for the create dialog. */
function Field({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="grid items-center gap-3 sm:grid-cols-[104px_1fr]">
			<Label>{label}</Label>
			{children}
		</div>
	);
}
