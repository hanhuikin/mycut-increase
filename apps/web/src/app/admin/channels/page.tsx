"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { useLocale } from "@/locale/locale-context";
import {
	GateErrorView,
	LoadErrorView,
	type GateStatus,
	isGateStatus,
} from "../gate-error-view";

interface ProtocolOption {
	id: string;
	label: string;
	families: string[];
	supportsImageInput: boolean;
	defaultBaseUrl: string;
}

interface Channel {
	id: string;
	name: string;
	protocol: string;
	protocolLabel: string;
	baseUrl: string;
	models: Record<string, string>;
	priority: number;
	enabled: boolean;
	hasKey: boolean;
	keySuffix: string;
	updatedBy: string;
	updatedAt: string;
}

interface ModelOption {
	id: string;
	label: string;
}

interface MappingDraft {
	modelId: string;
	upstream: string;
}

interface ChannelDraft {
	id: string | null;
	name: string;
	protocol: string;
	baseUrl: string;
	apiKey: string;
	priority: string;
	enabled: boolean;
	mappings: MappingDraft[];
}

const ERROR_KEY: Record<string, string> = {
	name_required: "admin.channels.error_name_required",
	unknown_protocol: "admin.channels.error_unknown_protocol",
	invalid_base_url: "admin.channels.error_invalid_base_url",
	models_required: "admin.channels.error_models_required",
	unknown_model: "admin.channels.error_unknown_model",
};

function draftFrom(channel: Channel | null): ChannelDraft {
	if (!channel) {
		return {
			id: null,
			name: "",
			protocol: "",
			baseUrl: "",
			apiKey: "",
			priority: "0",
			enabled: true,
			mappings: [],
		};
	}
	return {
		id: channel.id,
		name: channel.name,
		protocol: channel.protocol,
		baseUrl: channel.baseUrl,
		apiKey: "",
		priority: String(channel.priority),
		enabled: channel.enabled,
		mappings: Object.entries(channel.models).map(([modelId, upstream]) => ({
			modelId,
			upstream,
		})),
	};
}

export default function AdminChannelsPage() {
	const { t } = useLocale();
	const [channels, setChannels] = useState<Channel[] | null>(null);
	const [protocols, setProtocols] = useState<ProtocolOption[]>([]);
	const [models, setModels] = useState<ModelOption[]>([]);
	const [gateError, setGateError] = useState<GateStatus | null>(null);
	const [loadFailure, setLoadFailure] = useState<string | null>(null);
	const [draft, setDraft] = useState<ChannelDraft | null>(null);
	const [saving, setSaving] = useState(false);
	const [formError, setFormError] = useState<string | null>(null);
	const [pendingDelete, setPendingDelete] = useState<Channel | null>(null);

	const load = useCallback(async () => {
		const [channelRes, modelRes] = await Promise.all([
			fetch("/api/admin/channels"),
			fetch("/api/admin/models"),
		]);
		for (const res of [channelRes, modelRes]) {
			if (res.ok) continue;
			if (isGateStatus(res.status)) {
				setGateError(res.status);
				return;
			}
			setLoadFailure(String(res.status));
			return;
		}
		setLoadFailure(null);
		const channelBody = (await channelRes.json()) as {
			channels: Channel[];
			protocols: ProtocolOption[];
		};
		setChannels(channelBody.channels);
		setProtocols(channelBody.protocols);
		const modelBody = (await modelRes.json()) as {
			models: Array<{ id: string; label: string }>;
		};
		setModels(modelBody.models.map((m) => ({ id: m.id, label: m.label })));
	}, []);

	useEffect(() => {
		load();
	}, [load]);

	const protocolDefaults = useMemo(() => {
		return new Map(protocols.map((p) => [p.id, p.defaultBaseUrl]));
	}, [protocols]);

	const update = <K extends keyof ChannelDraft>(
		key: K,
		value: ChannelDraft[K],
	) => setDraft((current) => (current ? { ...current, [key]: value } : current));

	const submit = async () => {
		if (!draft) return;
		setSaving(true);
		setFormError(null);
		try {
			const modelsMap: Record<string, string> = {};
			for (const mapping of draft.mappings) {
				if (mapping.modelId && mapping.upstream.trim()) {
					modelsMap[mapping.modelId] = mapping.upstream.trim();
				}
			}
			const payload = {
				name: draft.name,
				protocol: draft.protocol,
				baseUrl: draft.baseUrl,
				apiKey: draft.apiKey,
				models: modelsMap,
				priority: Number(draft.priority) || 0,
				enabled: draft.enabled,
			};
			const res = await fetch(
				draft.id
					? `/api/admin/channels/${encodeURIComponent(draft.id)}`
					: "/api/admin/channels",
				{
					method: draft.id ? "PATCH" : "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(payload),
				},
			);
			if (!res.ok) {
				if (isGateStatus(res.status)) {
					setGateError(res.status);
					return;
				}
				const body = (await res.json().catch(() => null)) as {
					error?: string;
				} | null;
				const code = (body?.error ?? "").split(":")[0];
				const key = ERROR_KEY[code];
				setFormError(key ? t[key as never] : t["admin.models.save_failed"]);
				return;
			}
			toast.success(
				draft.id ? t["admin.channels.saved"] : t["admin.channels.created"],
			);
			setDraft(null);
			await load();
		} finally {
			setSaving(false);
		}
	};

	const toggleEnabled = async (channel: Channel, enabled: boolean) => {
		const res = await fetch(
			`/api/admin/channels/${encodeURIComponent(channel.id)}`,
			{
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: channel.name,
					protocol: channel.protocol,
					baseUrl: channel.baseUrl,
					// Blank keeps the stored key.
					apiKey: "",
					models: channel.models,
					priority: channel.priority,
					enabled,
				}),
			},
		);
		if (!res.ok) {
			if (isGateStatus(res.status)) {
				setGateError(res.status);
				return;
			}
			toast.error(t["admin.models.save_failed"]);
			return;
		}
		await load();
	};

	const remove = async (channel: Channel) => {
		const res = await fetch(
			`/api/admin/channels/${encodeURIComponent(channel.id)}`,
			{ method: "DELETE" },
		);
		if (!res.ok) {
			if (isGateStatus(res.status)) {
				setGateError(res.status);
				return;
			}
			toast.error(t["admin.models.save_failed"]);
			return;
		}
		toast.success(t["admin.channels.deleted"]);
		await load();
	};

	if (gateError) {
		return <GateErrorView status={gateError} />;
	}
	if (loadFailure) {
		return <LoadErrorView status={loadFailure} onRetry={load} />;
	}

	return (
		<div className="flex flex-col gap-4">
			<div className="flex flex-wrap items-start gap-3">
				<p className="text-muted-foreground max-w-3xl text-[13px] leading-relaxed">
					{t["admin.channels.hint"]}
				</p>
				<Button
					size="sm"
					className="ml-auto"
					onClick={() => {
						setFormError(null);
						setDraft(draftFrom(null));
					}}
				>
					{t["admin.channels.create"]}
				</Button>
			</div>

			{channels === null ? (
				<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
					{Array.from({ length: 4 }, (_, index) => (
						<Skeleton key={index} className="h-40 w-full" />
					))}
				</div>
			) : channels.length === 0 ? (
				<p className="text-muted-foreground border-border rounded-xl border border-dashed py-10 text-center text-[13px]">
					{t["admin.channels.empty"]}
				</p>
			) : (
				<div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
					{channels.map((channel) => (
						<div
							key={channel.id}
							className="bg-card border-border flex flex-col gap-3 rounded-xl border p-4"
						>
							<div className="flex items-start gap-2">
								<div className="min-w-0">
									<div className="truncate text-[15px] font-semibold">
										{channel.name}
									</div>
									<div className="text-muted-foreground mt-0.5 text-[12.5px]">
										{channel.protocolLabel}
									</div>
								</div>
								<Switch
									className="ml-auto"
									checked={channel.enabled}
									onCheckedChange={(enabled) =>
										toggleEnabled(channel, enabled)
									}
								/>
							</div>

							<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px]">
								<span className="text-muted-foreground">
									{t["admin.channels.col_priority"]}{" "}
									<span className="text-foreground font-mono">
										{channel.priority}
									</span>
								</span>
								<span
									className={
										channel.hasKey
											? "text-muted-foreground"
											: "text-caution"
									}
								>
									{channel.hasKey
										? t["admin.models.key_shared"].replace(
												"{suffix}",
												channel.keySuffix,
											)
										: t["admin.channels.key_missing"]}
								</span>
								{!channel.enabled && (
									<span className="text-muted-foreground">
										{t["admin.models.disabled"]}
									</span>
								)}
							</div>

							<div className="text-muted-foreground text-[12.5px]">
								{t["admin.channels.col_models"]} ·{" "}
								{Object.keys(channel.models).length}
							</div>
							<div className="flex flex-wrap gap-1">
								{Object.entries(channel.models).map(([modelId, upstream]) => (
									<span
										key={modelId}
										title={`${modelId} → ${upstream}`}
										className="border-border text-muted-foreground inline-block rounded-full border px-2 py-0.5 font-mono text-[11.5px]"
									>
										{modelId}
									</span>
								))}
							</div>

							<div className="mt-auto flex items-center gap-3">
								<Button
									variant="link"
									size="sm"
									className="h-auto p-0 text-[13px]"
									onClick={() => {
										setFormError(null);
										setDraft(draftFrom(channel));
									}}
								>
									{t["admin.channels.edit"]}
								</Button>
								<Button
									variant="link"
									size="sm"
									className="text-destructive h-auto p-0 text-[13px]"
									onClick={() => setPendingDelete(channel)}
								>
									{t["admin.channels.delete"]}
								</Button>
								{channel.updatedBy && (
									<span className="text-muted-foreground ml-auto font-mono text-[11.5px]">
										{channel.updatedBy}
									</span>
								)}
							</div>
						</div>
					))}
				</div>
			)}

			<Dialog
				open={draft !== null}
				onOpenChange={(open) => {
					if (!open) setDraft(null);
				}}
			>
				<DialogContent className="max-w-2xl">
					<DialogHeader>
						<DialogTitle>
							{draft?.id
								? t["admin.channels.edit"]
								: t["admin.channels.create"]}
						</DialogTitle>
						<DialogDescription>{t["admin.channels.hint"]}</DialogDescription>
					</DialogHeader>

					{draft && (
						<DialogBody className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto">
							<div className="grid gap-3 sm:grid-cols-2">
								<div className="flex flex-col gap-1.5">
									<Label>{t["admin.channels.field_name"]}</Label>
									<Input
										value={draft.name}
										onChange={(event) => update("name", event.target.value)}
										size="sm"
									/>
								</div>
								<div className="flex flex-col gap-1.5">
									<Label>{t["admin.channels.field_protocol"]}</Label>
									<select
										value={draft.protocol}
										onChange={(event) => update("protocol", event.target.value)}
										className="border-border bg-input focus-visible:border-primary/50 h-7 rounded-md border px-2 text-[13px] outline-none"
									>
										<option value="">—</option>
										{protocols.map((protocol) => (
											<option key={protocol.id} value={protocol.id}>
												{protocol.label}
											</option>
										))}
									</select>
								</div>
							</div>

							<div className="flex flex-col gap-1.5">
								<Label>{t["admin.channels.field_base_url"]}</Label>
								<Input
									value={draft.baseUrl}
									onChange={(event) => update("baseUrl", event.target.value)}
									size="sm"
									className="font-mono"
									placeholder={
										protocolDefaults.get(draft.protocol) ??
										t["admin.channels.base_url_placeholder"]
									}
								/>
							</div>

							<div className="flex flex-col gap-1.5">
								<Label>{t["admin.channels.field_api_key"]}</Label>
								<Input
									type="password"
									value={draft.apiKey}
									onChange={(event) => update("apiKey", event.target.value)}
									size="sm"
									className="font-mono"
									autoComplete="off"
									placeholder={
										draft.id
											? t["admin.channels.api_key_keep"]
											: t["admin.channels.api_key_placeholder"]
									}
								/>
							</div>

							<div className="flex flex-wrap items-end gap-4">
								<div className="flex flex-col gap-1.5">
									<Label>{t["admin.channels.field_priority"]}</Label>
									<Input
										type="number"
										value={draft.priority}
										onChange={(event) =>
											update("priority", event.target.value)
										}
										size="sm"
										className="w-24 font-mono"
									/>
								</div>
								<div className="flex items-center gap-2 pb-1">
									<Switch
										checked={draft.enabled}
										onCheckedChange={(enabled) => update("enabled", enabled)}
									/>
									<Label>{t["admin.channels.field_enabled"]}</Label>
								</div>
							</div>

							<div className="flex flex-col gap-2">
								<div>
									<Label>{t["admin.channels.models_title"]}</Label>
									<p className="text-muted-foreground mt-1 text-[12.5px]">
										{t["admin.channels.models_hint"]}
									</p>
								</div>
								{draft.mappings.length === 0 && (
									<p className="text-caution text-[12.5px]">
										{t["admin.channels.no_mapping"]}
									</p>
								)}
								{draft.mappings.map((mapping, index) => (
									<div
										key={`${mapping.modelId}-${index}`}
										className="flex items-center gap-2"
									>
										<select
											value={mapping.modelId}
											onChange={(event) =>
												update(
													"mappings",
													draft.mappings.map((entry, i) =>
														i === index
															? { ...entry, modelId: event.target.value }
															: entry,
													),
												)
											}
											className="border-border bg-input focus-visible:border-primary/50 h-7 min-w-40 rounded-md border px-2 font-mono text-[12.5px] outline-none"
										>
											<option value="">—</option>
											{models.map((model) => (
												<option key={model.id} value={model.id}>
													{model.id}
												</option>
											))}
										</select>
										<Input
											value={mapping.upstream}
											onChange={(event) =>
												update(
													"mappings",
													draft.mappings.map((entry, i) =>
														i === index
															? { ...entry, upstream: event.target.value }
															: entry,
													),
												)
											}
											size="sm"
											className="flex-1 font-mono"
											placeholder={t["admin.channels.upstream_placeholder"]}
										/>
										<Button
											variant="ghost"
											size="sm"
											className="text-destructive h-7 px-2"
											onClick={() =>
												update(
													"mappings",
													draft.mappings.filter((_, i) => i !== index),
												)
											}
										>
											✕
										</Button>
									</div>
								))}
								<Button
									variant="outline"
									size="sm"
									className="self-start"
									onClick={() =>
										update("mappings", [
											...draft.mappings,
											{ modelId: "", upstream: "" },
										])
									}
								>
									{t["admin.channels.add_mapping"]}
								</Button>
							</div>

							{formError && (
								<p className="text-destructive text-[13px]">{formError}</p>
							)}
						</DialogBody>
					)}

					<DialogFooter>
						<Button variant="outline" size="sm" onClick={() => setDraft(null)}>
							{t["admin.models.create_cancel"]}
						</Button>
						<Button size="sm" disabled={saving} onClick={submit}>
							{draft?.id
								? t["admin.models.save"]
								: t["admin.models.create_submit"]}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<AlertDialog
				open={pendingDelete !== null}
				onOpenChange={(open) => {
					if (!open) setPendingDelete(null);
				}}
			>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t["admin.channels.delete_title"]}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t["admin.channels.delete_body"]}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							{t["admin.models.create_cancel"]}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								const target = pendingDelete;
								setPendingDelete(null);
								if (target) void remove(target);
							}}
						>
							{t["admin.channels.delete"]}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
