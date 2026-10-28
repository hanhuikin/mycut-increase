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
import { Checkbox } from "@/components/ui/checkbox";
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
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
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
	/** Stable row identity — the key must not change when the select does. */
	uid: string;
	modelId: string;
	upstream: string;
}

function mappingUid(): string {
	return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
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
			uid: mappingUid(),
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
	const [probing, setProbing] = useState(false);
	const [fetchedModels, setFetchedModels] = useState<string[]>([]);
	const [pickerOpen, setPickerOpen] = useState(false);
	const [modelPickerOpen, setModelPickerOpen] = useState(false);

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

	// Mapping-row edits go through setDraft directly with functional
	// updates: rapid keystrokes read the latest state instead of a stale
	// render-time snapshot, so consecutive inputs can't overwrite each other.
	const updateMappings = (
		updater: (current: MappingDraft[]) => MappingDraft[],
	) => setDraft((current) => (current ? { ...current, mappings: updater(current.mappings) } : current));

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

	// One probe call serves both actions: it fetches the vendor's model
	// list, which proves the endpoint + key work. The typed key is passed
	// transiently; for an edited channel with the key left blank the
	// server reuses the stored one (never revealed to this page). The
	// fetched names feed the multi-select picker next to the mappings.
	const probe = async (options?: { openPickerAfter?: boolean }) => {
		const openPickerAfter = options?.openPickerAfter ?? false;
		if (!draft) return;
		setProbing(true);
		try {
			const res = await fetch("/api/admin/channels/probe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					protocol: draft.protocol,
					baseUrl: draft.baseUrl,
					apiKey: draft.apiKey,
					channelId: draft.id ?? "",
				}),
			});
			const body = (await res.json().catch(() => null)) as {
				ok?: boolean;
				models?: string[];
				error?: string;
			} | null;
			if (isGateStatus(res.status)) {
				setGateError(res.status);
				return;
			}
			if (!res.ok || !body?.ok) {
				const code = (body?.error ?? "").split(":")[0];
				if (code === "list_unsupported") {
					toast.error(t["admin.channels.list_unsupported"]);
				} else if (code === "probe_timeout") {
					toast.error(t["admin.channels.probe_timeout"]);
				} else {
					toast.error(
						t["admin.channels.probe_failed"].replace(
							"{error}",
							body?.error ?? String(res.status),
						),
					);
				}
				return;
			}
			setFetchedModels(body.models ?? []);
			if (openPickerAfter) {
				setPickerOpen(true);
			} else {
				toast.success(
					t["admin.channels.probe_ok"].replace(
						"{count}",
						String(body.models?.length ?? 0),
					),
				);
			}
		} catch {
			toast.error(t["admin.channels.probe_failed"].replace("{error}", "network"));
		} finally {
			setProbing(false);
		}
	};

	const pickerDisabled =
		!draft?.protocol ||
		!protocols.some((protocol) => protocol.id === draft.protocol);
	const canProbe = !pickerDisabled && !probing;

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
					if (!open) {
						setDraft(null);
						// Picker state is page-level; a stale `open` would
						// pop the pickers open the moment the dialog remounts.
						setPickerOpen(false);
						setModelPickerOpen(false);
					}
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

							<div className="flex flex-wrap items-center gap-2">
								<Button
									variant="outline"
									size="sm"
									disabled={!canProbe}
									onClick={() => void probe()}
								>
									{probing ? <Spinner className="size-3.5" /> : null}
									{t["admin.channels.probe"]}
								</Button>
								{fetchedModels.length > 0 && (
									<span className="text-muted-foreground font-mono text-[11.5px]">
										{String(fetchedModels.length)} models
									</span>
								)}
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
										key={mapping.uid}
										className="flex items-center gap-2"
									>
										<Input
											value={mapping.modelId}
											onChange={(event) =>
												updateMappings((currentMappings) =>
													currentMappings.map((entry, i) =>
														i === index
															? { ...entry, modelId: event.target.value }
															: entry,
													),
												)
											}
											size="sm"
											className="min-w-40 font-mono"
											list="mapping-model-suggestions"
											placeholder={t["admin.channels.model_id_placeholder"]}
										/>
										<datalist id="mapping-model-suggestions">
											{models.map((model) => (
												<option key={model.id} value={model.id} />
											))}
										</datalist>
										<Input
											value={mapping.upstream}
											onChange={(event) =>
												updateMappings((currentMappings) =>
													currentMappings.map((entry, i) =>
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
												updateMappings((currentMappings) =>
													currentMappings.filter((_, i) => i !== index),
												)
											}
										>
											✕
										</Button>
									</div>
								))}
								<div className="flex flex-wrap items-center gap-2">
									<PickerPopover
										open={modelPickerOpen}
										onOpenChange={setModelPickerOpen}
										title={t["admin.channels.add_mapping"]}
										items={models.map((model) => model.id)}
										disabled={models.length === 0}
										onConfirm={(selectedIds) => {
											if (!draft) return;
											const existing = new Set(
												draft.mappings.map((mapping) => mapping.modelId),
											);
											// The upstream name defaults to the system model
											// id — most vendors use the same name — and
											// stays editable.
											const additions = selectedIds
												.filter((id) => !existing.has(id))
												.map((id) => ({
													uid: mappingUid(),
													modelId: id,
													upstream: id,
												}));
											if (additions.length === 0) return;
											updateMappings((currentMappings) => [
											...currentMappings,
											...additions,
										]);
										}}
									/>
									<PickerPopover
										open={pickerOpen}
										onOpenChange={(next) => {
											// Opening with a stale/empty list triggers a
											// fresh fetch first; the probe opens the
											// picker on success.
											if (next && fetchedModels.length === 0) {
												void probe({ openPickerAfter: true });
												return;
											}
											setPickerOpen(next);
										}}
										title={t["admin.channels.fetch_models"]}
										items={fetchedModels}
										disabled={!canProbe}
										onConfirm={(selectedNames) => {
											if (!draft) return;
											const existing = new Set(
												draft.mappings
													.map((mapping) => mapping.upstream.trim())
													.filter(Boolean),
											);
											const additions = selectedNames
												.filter((name) => !existing.has(name))
												.map((name) => ({
													uid: mappingUid(),
													modelId: "",
													upstream: name,
												}));
											if (additions.length === 0) return;
											updateMappings((currentMappings) => [
											...currentMappings,
											...additions,
										]);
										}}
									/>
								</div>
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

/**
 * Multi-select popover over a list of items (upstream model names fetched
 * from the vendor, or system model ids from the catalogue). Defaults to
 * selecting everything; confirm hands the checked items to the caller.
 */
function PickerPopover({
	open,
	onOpenChange,
	title,
	items,
	disabled,
	onConfirm,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	items: string[];
	disabled: boolean;
	onConfirm: (selected: string[]) => void;
}) {
	const { t } = useLocale();
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());

	// Reset to "everything selected" whenever the picker opens.
	const handleOpenChange = (next: boolean) => {
		if (next) {
			setQuery("");
			setSelected(new Set(items));
		}
		onOpenChange(next);
	};

	const filtered = useMemo(
		() =>
			items.filter((item) =>
				item.toLowerCase().includes(query.trim().toLowerCase()),
			),
		[items, query],
	);
	const allFilteredSelected =
		filtered.length > 0 && filtered.every((item) => selected.has(item));

	const toggle = (item: string) => {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(item)) {
				next.delete(item);
			} else {
				next.add(item);
			}
			return next;
		});
	};

	return (
		<Popover open={open} onOpenChange={handleOpenChange}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					className="self-start"
					disabled={disabled}
				>
					{title}
				</Button>
			</PopoverTrigger>
			<PopoverContent
				className="z-300 w-80 p-2"
				align="start"
			>
				<Input
					value={query}
					onChange={(event) => setQuery(event.target.value)}
					size="sm"
					className="mb-2 font-mono"
					placeholder={t["admin.channels.search_models"]}
				/>
				<div className="mb-2 flex items-center justify-between px-1">
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground text-[11.5px]"
						onClick={() =>
							setSelected(
								allFilteredSelected
									? new Set(
											[...selected].filter(
												(item) => !filtered.includes(item),
											),
										)
									: new Set([...selected, ...filtered]),
							)
						}
					>
						{allFilteredSelected
							? t["admin.channels.clear"]
							: t["admin.channels.select_all"]}
					</button>
					<span className="text-muted-foreground font-mono text-[11px]">
						{selected.size}/{items.length}
					</span>
				</div>
				<div className="max-h-56 overflow-y-auto pr-1">
					{filtered.length === 0 ? (
						<p className="text-muted-foreground px-1 py-3 text-center text-[12px]">
							{t["admin.channels.fetch_empty"]}
						</p>
					) : (
						filtered.map((item) => (
							<label
								key={item}
								className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-md px-1 py-1.5"
							>
								<Checkbox
									checked={selected.has(item)}
									onCheckedChange={() => toggle(item)}
								/>
								<span className="truncate font-mono text-[12px]">
									{item}
								</span>
							</label>
						))
					)}
				</div>
				<div className="mt-2 flex justify-end gap-2 border-t pt-2">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => onOpenChange(false)}
					>
						{t["admin.models.create_cancel"]}
					</Button>
					<Button
						size="sm"
						disabled={selected.size === 0}
						onClick={() => {
							onConfirm([...selected]);
							onOpenChange(false);
						}}
					>
						{t["admin.channels.add_selected"]}
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
