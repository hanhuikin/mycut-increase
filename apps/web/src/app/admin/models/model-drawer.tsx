"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
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
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import type { LocaleKey } from "@/locale";
import { useLocale } from "@/locale/locale-context";
import { LoadErrorView, type GateStatus, isGateStatus } from "../gate-error-view";

/**
 * A channel as this drawer needs it: the mapping table, plus the fields a
 * mapping write has to send back untouched.
 */
interface ChannelRecord {
	id: string;
	name: string;
	protocol: string;
	baseUrl: string;
	models: Record<string, string>;
	priority: number;
	enabled: boolean;
}

const VIDEO_MODES: { value: string; labelKey: LocaleKey }[] = [
	{ value: "text-to-video", labelKey: "admin.models.mode_text" },
	{ value: "image-to-video", labelKey: "admin.models.mode_image" },
];

const KIND_LABEL_KEY: Record<string, LocaleKey> = {
	video: "admin.models.kind_video",
	tool: "admin.models.kind_tool",
	audio: "admin.models.kind_audio",
	local: "admin.models.kind_local",
};

/** One channel's relationship to this model, as the server reports it. */
interface ChannelCoverage {
	channelId: string;
	name: string;
	protocolLabel: string;
	priority: number;
	enabled: boolean;
	hasKey: boolean;
	usable: boolean;
}

export interface ModelDetail {
	id: string;
	label: string;
	kind: string;
	modes: string[];
	supportsAudio: boolean;
	maxDuration: number;
	pricePerSecond720: number | null;
	pricePerSecond1080: number | null;
	pricePerCall: number | null;
	labelKey: string | null;
	descriptionKey: string | null;
	dailyLimit: number | null;
	enabled: boolean;
	requiresPro: boolean;
	sortOrder: number;
	/** Read-only here: channels are configured on their own page. */
	channels: ChannelCoverage[];
}

/** Numeric fields live as strings so they can be cleared to null. */
interface FormState {
	label: string;
	sortOrder: string;
	maxDuration: string;
	enabled: boolean;
	requiresPro: boolean;
	supportsAudio: boolean;
	modes: string[];
	pricePerSecond720: string;
	pricePerSecond1080: string;
	pricePerCall: string;
	dailyLimit: string;
	labelKey: string;
	descriptionKey: string;
}

const text = (value: number | null) => (value === null ? "" : String(value));

function toForm(model: ModelDetail): FormState {
	return {
		label: model.label,
		sortOrder: String(model.sortOrder),
		maxDuration: String(model.maxDuration),
		enabled: model.enabled,
		requiresPro: model.requiresPro,
		supportsAudio: model.supportsAudio,
		modes: [...model.modes],
		pricePerSecond720: text(model.pricePerSecond720),
		pricePerSecond1080: text(model.pricePerSecond1080),
		pricePerCall: text(model.pricePerCall),
		dailyLimit: text(model.dailyLimit),
		labelKey: model.labelKey ?? "",
		descriptionKey: model.descriptionKey ?? "",
	};
}

function numberOrNull(value: string): number | null {
	const trimmed = value.trim();
	return trimmed === "" ? null : Number(trimmed);
}

function toPayload(form: FormState) {
	return {
		label: form.label,
		sortOrder: Number(form.sortOrder) || 0,
		maxDuration: Number(form.maxDuration) || 1,
		enabled: form.enabled,
		requiresPro: form.requiresPro,
		supportsAudio: form.supportsAudio,
		modes: form.modes,
		pricePerSecond720: numberOrNull(form.pricePerSecond720),
		pricePerSecond1080: numberOrNull(form.pricePerSecond1080),
		pricePerCall: numberOrNull(form.pricePerCall),
		dailyLimit: numberOrNull(form.dailyLimit),
		labelKey: form.labelKey.trim() || null,
		descriptionKey: form.descriptionKey.trim() || null,
	};
}

export function ModelDrawer({
	modelId,
	onClose,
	onSaved,
	onGate,
}: {
	modelId: string | null;
	onClose: () => void;
	onSaved: () => void;
	onGate: (status: GateStatus) => void;
}) {
	const { t } = useLocale();
	const [model, setModel] = useState<ModelDetail | null>(null);
	const [form, setForm] = useState<FormState | null>(null);
	const [saving, setSaving] = useState(false);
	const [loadFailure, setLoadFailure] = useState<string | null>(null);
	const [confirmDiscard, setConfirmDiscard] = useState(false);
	const [channels, setChannels] = useState<ChannelRecord[]>([]);
	const [addTarget, setAddTarget] = useState("");
	const [addUpstream, setAddUpstream] = useState("");
	const [adding, setAdding] = useState(false);

	const load = useCallback(
		async (id: string) => {
			const [modelRes, channelRes] = await Promise.all([
				fetch(`/api/admin/models/${encodeURIComponent(id)}`),
				fetch("/api/admin/channels"),
			]);
			for (const res of [modelRes, channelRes]) {
				if (res.ok) continue;
				if (isGateStatus(res.status)) {
					onGate(res.status);
					return;
				}
				setLoadFailure(String(res.status));
				return;
			}
			setLoadFailure(null);
			// Read both bodies before touching state: the drawer joins them, and a
			// render in between would show the channel list one fetch short.
			const body = (await modelRes.json()) as { model: ModelDetail };
			const channelBody = (await channelRes.json()) as {
				channels: ChannelRecord[];
			};
			setModel(body.model);
			setForm(toForm(body.model));
			setChannels(channelBody.channels);
		},
		[onGate],
	);

	useEffect(() => {
		if (!modelId) {
			setModel(null);
			setForm(null);
			return;
		}
		load(modelId);
	}, [modelId, load]);

	const initial = useMemo(() => (model ? toForm(model) : null), [model]);

	const dirtyKeys = useMemo(() => {
		if (!form || !initial) return [];
		return (Object.keys(form) as Array<keyof FormState>).filter(
			(key) => JSON.stringify(form[key]) !== JSON.stringify(initial[key]),
		);
	}, [form, initial]);

	const update = <K extends keyof FormState>(key: K, value: FormState[K]) =>
		setForm((current) => (current ? { ...current, [key]: value } : current));

	const requestClose = () => {
		if (dirtyKeys.length > 0) {
			setConfirmDiscard(true);
			return;
		}
		onClose();
	};

	const save = async () => {
		if (!form || !modelId) return;
		setSaving(true);
		try {
			const res = await fetch(
				`/api/admin/models/${encodeURIComponent(modelId)}`,
				{
					method: "PATCH",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(toPayload(form)),
				},
			);
			if (!res.ok) {
				if (isGateStatus(res.status)) {
					onGate(res.status);
					return;
				}
				const body = (await res.json().catch(() => null)) as {
					error?: string;
				} | null;
				toast.error(body?.error ?? t["admin.models.save_failed"]);
				return;
			}
			const body = (await res.json()) as { model: ModelDetail };
			setModel(body.model);
			setForm(toForm(body.model));
			toast.success(t["admin.models.saved"]);
			onSaved();
		} finally {
			setSaving(false);
		}
	};

	const channelById = useMemo(
		() => new Map(channels.map((channel) => [channel.id, channel])),
		[channels],
	);

	/** Channels this model is not on yet — the ones that can be added. */
	const candidates = useMemo(
		() => (model ? channels.filter((entry) => !(model.id in entry.models)) : []),
		[channels, model],
	);

	/** Upstream names the selected channel already knows, offered as suggestions. */
	const upstreamSuggestions = useMemo(() => {
		const selected = addTarget ? channelById.get(addTarget) : undefined;
		return selected ? [...new Set(Object.values(selected.models))] : [];
	}, [addTarget, channelById]);

	/**
	 * A channel edit reloads the drawer for fresh coverage. The model row itself
	 * is untouched by it, so whatever the admin has typed elsewhere survives.
	 */
	const refreshRoutes = useCallback(async () => {
		if (!modelId) return;
		const kept = form;
		await load(modelId);
		if (kept) setForm(kept);
	}, [form, load, modelId]);

	/** Writes one channel's mapping table back, leaving every other field alone. */
	const patchChannelModels = async ({
		channel,
		models,
	}: {
		channel: ChannelRecord;
		models: Record<string, string>;
	}) => {
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
					models,
					priority: channel.priority,
					enabled: channel.enabled,
				}),
			},
		);
		if (res.ok) return true;
		if (isGateStatus(res.status)) {
			onGate(res.status);
			return false;
		}
		toast.error(t["admin.models.save_failed"]);
		return false;
	};

	/** Point one channel at a different upstream model, leaving its other fields alone. */
	const commitUpstream = async ({
		channel,
		upstream,
	}: {
		channel: ChannelRecord;
		upstream: string;
	}) => {
		if (!modelId) return false;
		const saved = await patchChannelModels({
			channel,
			models: { ...channel.models, [modelId]: upstream },
		});
		if (!saved) return false;
		toast.success(t["admin.models.channel_upstream_saved"]);
		await refreshRoutes();
		onSaved();
		return true;
	};

	/** Unmap this model from a channel. The channel itself stays. */
	const removeMapping = async (channel: ChannelRecord) => {
		if (!modelId) return;
		const rest = Object.fromEntries(
			Object.entries(channel.models).filter(([id]) => id !== modelId),
		);
		if (!(await patchChannelModels({ channel, models: rest }))) return;
		toast.success(t["admin.models.channel_removed"]);
		await refreshRoutes();
		onSaved();
	};

	/** Add this model to a channel, naming the upstream model it runs there. */
	const addMapping = async () => {
		if (!modelId) return;
		const channel = channelById.get(addTarget);
		const upstream = addUpstream.trim();
		if (!channel || !upstream) return;
		setAdding(true);
		const saved = await patchChannelModels({
			channel,
			models: { ...channel.models, [modelId]: upstream },
		});
		setAdding(false);
		if (!saved) return;
		toast.success(t["admin.models.channel_added"]);
		setAddTarget("");
		setAddUpstream("");
		await refreshRoutes();
		onSaved();
	};

	const isVideo = model?.kind === "video";
	const isLocal = model?.kind === "local";

	return (
		<>
			<Sheet
				open={modelId !== null}
				onOpenChange={(open) => {
					if (!open) requestClose();
				}}
			>
				<SheetContent
					side="right"
					className="flex w-full flex-col gap-0 p-0 sm:max-w-[620px]"
				>
					{!model || !form ? (
						<div className="flex flex-1 items-center justify-center">
							{loadFailure ? (
								<LoadErrorView
									status={loadFailure}
									onRetry={() => modelId && load(modelId)}
								/>
							) : (
								<Spinner />
							)}
						</div>
					) : (
						<>
							<div className="border-border border-b px-5 py-4 pr-12">
								<div className="text-base font-semibold">{model.label}</div>
								<div className="text-muted-foreground mt-0.5 font-mono text-[11.5px]">
									{model.id} ·{" "}
									{t[KIND_LABEL_KEY[model.kind] ?? "admin.models.kind_video"]}
								</div>
							</div>

							<div className="flex flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
								<div className="flex items-center justify-between gap-3">
									<ToggleRow
										label={t["admin.models.enabled"]}
										checked={form.enabled}
										onChange={(checked) => update("enabled", checked)}
									/>
									<ToggleRow
										label={t["admin.models.pro_tag"]}
										checked={form.requiresPro}
										onChange={(checked) => update("requiresPro", checked)}
									/>
								</div>

								{isLocal ? (
									<p className="text-muted-foreground text-[13px]">
										{t["admin.models.local_free"]}
									</p>
								) : (
									<Section
										title={t["admin.models.channels"]}
										hint={t["admin.models.channels_hint"]}
									>
										{model.channels.length === 0 ? (
											<p className="text-caution text-[13px]">
												{t["admin.models.no_channels"]}
											</p>
										) : (
											<ul className="flex flex-col gap-1.5">
												{model.channels.map((entry) => {
													const channel = channelById.get(entry.channelId);
													if (!channel) return null;
													const upstream = channel.models[model.id] ?? "";
													return (
														<li
															key={entry.channelId}
															className="border-border flex flex-col gap-2 rounded-md border px-3 py-2"
														>
															<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
																<span className="bg-accent text-muted-foreground grid size-4.5 place-items-center rounded font-mono text-[11.5px]">
																	{entry.priority}
																</span>
																<span className="font-semibold">{entry.name}</span>
																<span className="text-muted-foreground text-[11.5px]">
																	{entry.protocolLabel}
																</span>
																<span
																	className={`ml-auto text-[11.5px] ${
																		entry.usable
																			? "text-constructive"
																			: "text-caution"
																	}`}
																>
																	{entry.usable
																		? t["admin.models.channel_ready"]
																		: entry.hasKey
																			? t["admin.models.disabled"]
																			: t["admin.models.key_none"]}
																</span>
															</div>
															<div className="flex items-center gap-2">
																<span className="text-muted-foreground shrink-0 text-[12px]">
																	{t["admin.models.channel_upstream"]}
																</span>
																<UpstreamField
																	key={`${channel.id}:${upstream}`}
																	value={upstream}
																	onCommit={(next) =>
																		commitUpstream({ channel, upstream: next })
																	}
																/>
																<Button
																	variant="ghost"
																	size="sm"
																	className="text-destructive h-7 shrink-0 px-2 text-[12.5px]"
																	onClick={() => void removeMapping(channel)}
																>
																	{t["admin.models.channel_remove"]}
																</Button>
															</div>
														</li>
													);
												})}
											</ul>
										)}
										{candidates.length > 0 && (
											<div className="border-border flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2">
												<select
													value={addTarget}
													onChange={(event) => setAddTarget(event.target.value)}
													className="border-border bg-input focus-visible:border-primary/50 h-7 min-w-40 rounded-md border px-2 text-[12.5px] outline-none"
												>
													<option value="">{t["admin.models.channel_pick"]}</option>
													{candidates.map((channel) => (
														<option key={channel.id} value={channel.id}>
															{channel.name}
														</option>
													))}
												</select>
												<Input
													value={addUpstream}
													onChange={(event) => setAddUpstream(event.target.value)}
													list="model-upstream-names"
													size="sm"
													className="flex-1 font-mono"
													placeholder={t["admin.models.channel_upstream"]}
												/>
												<datalist id="model-upstream-names">
													{upstreamSuggestions.map((name) => (
														<option key={name} value={name} />
													))}
												</datalist>
												<Button
													size="sm"
													disabled={adding || !addTarget || !addUpstream.trim()}
													onClick={() => void addMapping()}
												>
													{t["admin.models.channel_add"]}
												</Button>
											</div>
										)}
										<Link
											href="/admin/channels"
											className="text-primary text-[13px] hover:underline"
										>
											{t["admin.models.manage_channels"]} →
										</Link>
									</Section>
								)}

								{isVideo && (
									<Section title={t["admin.models.capability"]}>
										{VIDEO_MODES.map((mode) => (
											<ToggleRow
												key={mode.value}
												label={t[mode.labelKey]}
												checked={form.modes.includes(mode.value)}
												onChange={(checked) =>
													update(
														"modes",
														checked
															? [...form.modes, mode.value]
															: form.modes.filter(
																	(entry) => entry !== mode.value,
																),
													)
												}
											/>
										))}
										<ToggleRow
											label={t["admin.models.supports_audio"]}
											checked={form.supportsAudio}
											onChange={(checked) => update("supportsAudio", checked)}
										/>
										<Field label={t["admin.models.max_duration"]}>
											<Input
												type="number"
												min={1}
												value={form.maxDuration}
												onChange={(event) =>
													update("maxDuration", event.target.value)
												}
												size="sm"
												className="font-mono"
											/>
										</Field>
									</Section>
								)}

								<Section title={t["admin.models.col_price"]}>
									<Field label={t["admin.models.price_720"]}>
										<Input
											type="number"
											min={0}
											value={form.pricePerSecond720}
											onChange={(event) =>
												update("pricePerSecond720", event.target.value)
											}
											size="sm"
											className="font-mono"
											placeholder={t["admin.models.unlimited"]}
										/>
									</Field>
									<Field label={t["admin.models.price_1080"]}>
										<Input
											type="number"
											min={0}
											value={form.pricePerSecond1080}
											onChange={(event) =>
												update("pricePerSecond1080", event.target.value)
											}
											size="sm"
											className="font-mono"
											placeholder={t["admin.models.unlimited"]}
										/>
									</Field>
									<Field label={t["admin.models.price_call"]}>
										<Input
											type="number"
											min={0}
											value={form.pricePerCall}
											onChange={(event) =>
												update("pricePerCall", event.target.value)
											}
											size="sm"
											className="font-mono"
											placeholder={t["admin.models.unlimited"]}
										/>
									</Field>
									<Field label={t["admin.models.daily_limit"]}>
										<Input
											type="number"
											min={0}
											value={form.dailyLimit}
											onChange={(event) =>
												update("dailyLimit", event.target.value)
											}
											size="sm"
											className="font-mono"
											placeholder={t["admin.models.unlimited"]}
										/>
									</Field>
								</Section>

								<Section
									title={t["admin.models.copy"]}
									hint={t["admin.models.copy_hint"]}
								>
									<Field label={t["admin.models.label"]}>
										<Input
											value={form.label}
											onChange={(event) => update("label", event.target.value)}
											size="sm"
										/>
									</Field>
									<Field label={t["admin.models.sort_order"]}>
										<Input
											type="number"
											value={form.sortOrder}
											onChange={(event) =>
												update("sortOrder", event.target.value)
											}
											size="sm"
											className="font-mono"
										/>
									</Field>
									<Field label={t["admin.models.label_key"]}>
										<Input
											value={form.labelKey}
											onChange={(event) =>
												update("labelKey", event.target.value)
											}
											size="sm"
											className="font-mono"
										/>
									</Field>
									<Field label={t["admin.models.description_key"]}>
										<Input
											value={form.descriptionKey}
											onChange={(event) =>
												update("descriptionKey", event.target.value)
											}
											size="sm"
											className="font-mono"
										/>
									</Field>
								</Section>
							</div>

							{dirtyKeys.length > 0 && (
								<div className="border-border bg-card flex items-center gap-2 border-t px-5 py-3">
									<span className="text-muted-foreground text-[12.5px]">
										{t["admin.models.dirty_count"].replace(
											"{count}",
											String(dirtyKeys.length),
										)}
									</span>
									<span className="ml-auto flex gap-2">
										<Button
											variant="ghost"
											size="sm"
											onClick={() => {
												if (initial) setForm(initial);
											}}
										>
											{t["admin.models.discard"]}
										</Button>
										<Button size="sm" onClick={save} disabled={saving}>
											{saving ? <Spinner /> : t["admin.models.save"]}
										</Button>
									</span>
								</div>
							)}
						</>
					)}
				</SheetContent>
			</Sheet>

			<AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							{t["admin.models.discard_title"]}
						</AlertDialogTitle>
						<AlertDialogDescription>
							{t["admin.models.discard_body"]}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>
							{t["admin.models.discard_cancel"]}
						</AlertDialogCancel>
						<AlertDialogAction
							onClick={() => {
								setConfirmDiscard(false);
								onClose();
							}}
						>
							{t["admin.models.discard_confirm"]}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	);
}

/**
 * One channel's upstream model name, as a single-field form: commits on blur or
 * Enter, and reverts to the stored name when the write fails.
 */
function UpstreamField({
	value,
	onCommit,
}: {
	value: string;
	onCommit: (next: string) => Promise<boolean>;
}) {
	const { t } = useLocale();
	const [busy, setBusy] = useState(false);

	const commit = async (input: HTMLInputElement) => {
		const next = input.value.trim();
		// Blank is never a valid upstream name, and no change means nothing to write.
		if (!next || next === value) {
			input.value = value;
			return;
		}
		setBusy(true);
		const saved = await onCommit(next);
		setBusy(false);
		if (!saved) input.value = value;
	};

	return (
		<Input
			defaultValue={value}
			disabled={busy}
			aria-label={t["admin.models.channel_upstream"]}
			onKeyDown={(event) => {
				if (event.key === "Enter") event.currentTarget.blur();
			}}
			onBlur={(event) => void commit(event.currentTarget)}
			size="sm"
			className="flex-1 font-mono"
		/>
	);
}

function Section({
	title,
	hint,
	children,
}: {
	title: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="flex flex-col gap-2.5">
			<div>
				<h4 className="text-muted-foreground text-[11.5px] font-semibold tracking-[0.16em] uppercase">
					{title}
				</h4>
				{hint && (
					<p className="text-muted-foreground mt-1 text-[12.5px]">{hint}</p>
				)}
			</div>
			{children}
		</div>
	);
}

function Field({
	label,
	children,
}: {
	label: string;
	children: React.ReactNode;
}) {
	return (
		<div className="grid items-center gap-2 sm:grid-cols-[132px_1fr]">
			<Label>{label}</Label>
			{children}
		</div>
	);
}

function ToggleRow({
	label,
	checked,
	onChange,
}: {
	label: string;
	checked: boolean;
	onChange: (checked: boolean) => void;
}) {
	return (
		<div className="flex items-center gap-2">
			<Switch checked={checked} onCheckedChange={onChange} />
			<Label>{label}</Label>
		</div>
	);
}
