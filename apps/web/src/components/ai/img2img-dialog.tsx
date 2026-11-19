"use client";

/**
 * 多图生图对话框（入口：素材库批量动作条）· 方案一「紧凑单栏」。
 *
 * 布局：参考图横排小槽（＋ 合并上传/图库）→ 提示词（⌘↵ 生成）→ 建议 chips
 * → 比例/尺寸/数量分段控件 → 成本 + 生成 → 结果横滑条带（不撑高对话框）。
 * 生成会话状态在 img2img-store，关闭对话框不中断；时间轴插入由宿主注入。
 */

import React, { useEffect, useMemo, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { AiVideoMediaPickerDialog } from "@/components/editor/panels/assets/views/ai-video-media-picker";
import { useEditor } from "@/editor/use-editor";
import { useLocale } from "@/locale/locale-context";
import { estimateCost, useBilling } from "@/services/billing/client";
import {
	IMG2IMG_MAX_SLOTS,
	IMG2IMG_MODEL_ID,
	IMG2IMG_SIZE_CAPS,
	computeImageSize,
	resolveImageSize,
	useImg2ImgStore,
	validateCustomSize,
	type Img2ImgAspectRatio,
	type Img2ImgSlot,
} from "./img2img-store";
import { cn } from "@/utils/ui";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const ASPECTS: Img2ImgAspectRatio[] = ["1:1", "16:9", "3:4", "9:16"];
const SIZE_PRESETS: Array<768 | 1024 | 1536> = [768, 1024, 1536];

/** 建议文案：点击把模板句追加进提示词（@图N/@imgN 随界面语言）。 */
const SUGGESTION_TEMPLATES: Array<{
	key: string;
	zh: string;
	en: string;
}> = [
	{
		key: "sug_keep_role",
		zh: "保持 @图1 的角色外观不变，",
		en: "Keep the character from @img1 consistent, ",
	},
	{
		key: "sug_scene",
		zh: "把 @图1 的主体放入 @图2 的场景中，",
		en: "Place the subject of @img1 into the scene of @img2, ",
	},
	{
		key: "sug_style",
		zh: "整体氛围接近 @图3 的光影与色调，",
		en: "Match the lighting and palette of @img3, ",
	},
	{
		key: "sug_background",
		zh: "替换 @图1 的背景，主体保持不变，",
		en: "Replace the background of @img1, keep the subject, ",
	},
	{
		key: "sug_group",
		zh: "让 @图1 和 @图2 中的角色同框合影，",
		en: "Put the characters of @img1 and @img2 in one frame, ",
	},
];

export function MultiImg2ImgDialog({
	onInsertTimeline,
}: {
	onInsertTimeline: (assetId: string) => void;
}) {
	const { t, locale } = useLocale();
	const billing = useBilling();
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	const store = useImg2ImgStore();
	const {
		open,
		slots,
		results,
		prompt,
		aspectRatio,
		sizePreset,
		customSize,
		numImages,
		running,
		setOpen,
		close,
		setPrompt,
		setAspectRatio,
		setSizePreset,
		setCustomSize,
		setNumImages,
		addSlots,
		removeSlot,
		moveSlot,
		generate,
	} = store;

	const [pickerOpen, setPickerOpen] = useState(false);
	const [customOpen, setCustomOpen] = useState(false);
	const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
	const [draftW, setDraftW] = useState("1024");
	const [draftH, setDraftH] = useState("1024");
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const uploadRef = useRef<HTMLInputElement>(null);
	const dragFromRef = useRef<number | null>(null);

	// 打开自定义弹层时，以当前生效尺寸作为草稿初值
	useEffect(() => {
		if (!customOpen) return;
		const current = resolveImageSize(aspectRatio, sizePreset, customSize);
		setDraftW(String(current.w));
		setDraftH(String(current.h));
	}, [customOpen, aspectRatio, sizePreset, customSize]);

	const libraryImages = useMemo(
		() => editor.media.getAssets().filter((asset) => asset.type === "image"),
		// editor.media.getAssets() 是响应式快照，面板数据变化时随之刷新
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[editor, open],
	);

	const model = billing.models.get(IMG2IMG_MODEL_ID);
	const costPerCall = model
		? estimateCost({ model, resolution: "720p", seconds: 1 })
		: null;
	const totalCost = costPerCall != null ? costPerCall * numImages : null;
	const insufficient =
		billing.balance != null && totalCost != null && totalCost > billing.balance;

	const effectiveSize = resolveImageSize(aspectRatio, sizePreset, customSize);
	const canGenerate =
		!running &&
		activeProject != null &&
		slots.length >= 2 &&
		prompt.trim().length > 0 &&
		model != null &&
		!insufficient;

	const importAsset = async (
		file: File,
		name: string,
	): Promise<string | null> => {
		if (!activeProject) return null;
		const asset = await editor.media.addMediaAsset({
			projectId: activeProject.metadata.id,
			asset: {
				name,
				file,
				type: "image",
				url: URL.createObjectURL(file),
			},
		});
		return asset?.id ?? null;
	};

	const appendSuggestion = (template: { zh: string; en: string }) => {
		const text = locale === "zh" ? template.zh : template.en;
		setPrompt(prompt.trim() ? `${prompt.trim()} ${text}` : text);
	};

	const filesToSlots = (files: File[]): Img2ImgSlot[] =>
		files.map((file) => ({
			key: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			name: file.name,
			file,
			previewUrl: URL.createObjectURL(file),
		}));

	const assetUrlById = (assetId: string): string | null =>
		editor.media.getAssets().find((asset) => asset.id === assetId)?.url ?? null;

	const handleGenerate = () => {
		if (!canGenerate) return;
		void generate({
			importAsset,
			onFinished: (imported) => {
				if (imported > 0) {
					billing.refreshBalance();
				}
			},
		});
	};

	const applyCustomSize = () => {
		const parsed = validateCustomSize(Number(draftW), Number(draftH));
		if (!parsed) return;
		setCustomSize({ w: parsed.w, h: parsed.h });
		setCustomOpen(false);
	};

	return (
		<>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!next) close();
				}}
			>
				<DialogContent className="max-h-[92vh] max-w-[560px] gap-3 overflow-y-auto p-4 pt-3">
					<DialogHeader className="space-y-0 border-b-0 p-0">
						<DialogTitle className="text-[13px] font-semibold">
							{t["ai_img2img.title"]}
						</DialogTitle>
					</DialogHeader>

					{/* ① 参考图：64×48 小槽位横排 · 拖动排序 · 首位=主参考 */}
					<section>
						<div className="text-muted-foreground mx-0.5 mb-1 text-[10px]">
							{t["ai_img2img.slots_hint"]}
						</div>
						<div className="flex items-center gap-1.5">
							{slots.map((slot, index) => (
								<div
									key={slot.key}
									draggable
									onDragStart={() => {
										dragFromRef.current = index;
									}}
									onDragOver={(event) => {
										event.preventDefault();
										setDragOverIndex(index);
									}}
									onDragLeave={() =>
										setDragOverIndex((current) =>
											current === index ? null : current,
										)
									}
									onDragEnd={() => setDragOverIndex(null)}
									onDrop={(event) => {
										event.preventDefault();
										if (dragFromRef.current != null) {
											moveSlot(dragFromRef.current, index);
											dragFromRef.current = null;
										}
										setDragOverIndex(null);
									}}
									className={cn(
										"group border-muted-foreground/40 relative h-12 w-16 shrink-0 cursor-grab overflow-hidden rounded-lg border",
										dragOverIndex === index && "ring-primary ring-2",
									)}
								>
									{/* eslint-disable-next-line @next/next/no-img-element */}
									<img
										src={slot.previewUrl}
										alt={slot.name}
										className="size-full object-cover"
									/>
									{index === 0 ? (
										<span className="bg-primary absolute top-px left-0.5 rounded-[3px] px-1 text-[8px] leading-[14px] text-white">
											{t["ai_img2img.slot_main"]}
										</span>
									) : (
										<span className="absolute top-px left-0.5 rounded-[3px] bg-black/60 px-1 text-[8px] leading-[14px] text-white">
											{t["ai_img2img.slot_n"].replace("{n}", String(index + 1))}
										</span>
									)}
									{/* ✕ 常显（触屏/webview 没有 hover），悬停加深 */}
									<button
										type="button"
										aria-label={slot.name}
										disabled={running}
										className="absolute top-px right-1 text-[10px] leading-none text-white/75 drop-shadow-[0_0_3px_rgba(0,0,0,0.9)] transition-colors hover:text-white disabled:opacity-30"
										onClick={() => removeSlot(slot.key)}
									>
										✕
									</button>
								</div>
							))}
							{slots.length < IMG2IMG_MAX_SLOTS && (
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<button
											type="button"
											disabled={running}
											className="text-muted-foreground hover:border-primary/60 hover:text-foreground h-12 w-16 shrink-0 rounded-lg border-[1.5px] border-dashed text-base transition-colors disabled:opacity-50"
										>
											＋
										</button>
									</DropdownMenuTrigger>
									{/* portal 到 body，需高于 Dialog 的 z-250 才不会被盖住 */}
									<DropdownMenuContent className="z-[260]">
										<DropdownMenuItem onClick={() => uploadRef.current?.click()}>
											{t["ai_img2img.slot_add_upload"]}
										</DropdownMenuItem>
										<DropdownMenuItem onClick={() => setPickerOpen(true)}>
											{t["ai_img2img.slot_add_library"]}
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							)}
							<span className="text-muted-foreground text-[10px]">
								{slots.length}/{IMG2IMG_MAX_SLOTS}
							</span>
						</div>
						{slots.length < 2 && (
							<div className="mt-1 text-[10px] text-amber-500">
								{t["ai_img2img.slots_min"]}
							</div>
						)}
					</section>
					<input
						ref={uploadRef}
						type="file"
						accept="image/*"
						multiple
						className="hidden"
						onChange={(event) => {
							const files = Array.from(event.target.files ?? []);
							addSlots(filesToSlots(files));
							event.target.value = "";
						}}
					/>

					{/* ② 提示词（@图N 引用 · ⌘↵ 生成） */}
					<section>
						<div className="text-muted-foreground mx-0.5 mb-1 text-[10px]">
							{t["ai_img2img.prompt_label"]}
						</div>
						<textarea
							value={prompt}
							placeholder={t["ai_img2img.prompt_placeholder"]}
							className="border-border focus:ring-ring placeholder:text-muted-foreground/70 min-h-[90px] w-full resize-none rounded-lg border bg-transparent px-2 py-2 text-[11px] leading-relaxed outline-none"
							onChange={(event) => setPrompt(event.target.value)}
							onKeyDown={(event) => {
								if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
									event.preventDefault();
									handleGenerate();
								}
							}}
						/>
						<div className="mt-2 flex flex-wrap gap-1.5">
							{SUGGESTION_TEMPLATES.map((template) => (
								<button
									key={template.key}
									type="button"
									className="border-border text-muted-foreground hover:text-foreground rounded-full border px-2 py-0.5 text-[10px] transition-colors"
									onClick={() => appendSuggestion(template)}
								>
									{t[`ai_img2img.${template.key}` as keyof typeof t]}
								</button>
							))}
						</div>
					</section>

					{/* ③ 参数：比例 / 尺寸 / 数量（分段控件，样式对齐素材面板） */}
					<section className="flex flex-wrap items-center gap-x-1.5 gap-y-1.5">
						<div className="flex items-center gap-2">
							<span className="text-muted-foreground text-[10px]">
								{t["ai_img2img.params_aspect"]}
							</span>
							<div className="bg-card flex overflow-hidden rounded-lg border">
								{ASPECTS.map((value) => (
									<ParamChip
										key={value}
										label={value}
										selected={aspectRatio === value}
										disabled={running}
										onClick={() => setAspectRatio(value)}
									/>
								))}
							</div>
						</div>
						<div className="ml-1 flex items-center gap-2">
							<span className="text-muted-foreground text-[10px]">
								{t["ai_img2img.params_size"]}
							</span>
							<div className="bg-card flex overflow-hidden rounded-lg border">
								{SIZE_PRESETS.map((preset) => {
									const size = computeImageSize(aspectRatio, preset);
									const label = `${size.w}×${size.h}`;
									return (
										<ParamChip
											key={preset}
											label={label}
											selected={sizePreset === preset}
											disabled={running}
											onClick={() => setSizePreset(preset)}
										/>
									);
								})}
								<Popover open={customOpen} onOpenChange={setCustomOpen}>
									<PopoverTrigger asChild disabled={running}>
										<ParamChip
											label={
												sizePreset === "custom" && customSize
													? `${customSize.w}×${customSize.h}`
													: t["ai_img2img.size_custom"]
											}
											selected={sizePreset === "custom"}
											disabled={running}
										/>
									</PopoverTrigger>
									<PopoverContent
										className="z-[260] w-64 p-3"
										align="end"
										side="top"
									>
										<div className="text-muted-foreground mb-2 text-[10px]">
											{t["ai_img2img.params_size"]}
										</div>
										<div className="flex items-center gap-2">
											<SizeInput
												label={t["ai_img2img.size_width"]}
												value={draftW}
												onChange={setDraftW}
											/>
											<span className="text-muted-foreground text-xs">×</span>
											<SizeInput
												label={t["ai_img2img.size_height"]}
												value={draftH}
												onChange={setDraftH}
											/>
											<span className="text-muted-foreground text-xs">px</span>
										</div>
										<SizeHint draftW={draftW} draftH={draftH} />
										<div className="mt-2 flex justify-end gap-2">
											<Button
												variant="outline"
												size="sm"
												className="h-7 rounded-md px-2.5 text-[10px]"
												onClick={() => setCustomOpen(false)}
											>
												{t["common.cancel"]}
											</Button>
											<Button
												size="sm"
												className="bg-primary hover:bg-primary/90 h-7 rounded-md px-2.5 text-[10px] text-white"
												disabled={
													!validateCustomSize(Number(draftW), Number(draftH))
												}
												onClick={applyCustomSize}
											>
												{t["ai_img2img.size_apply"]}
											</Button>
										</div>
									</PopoverContent>
								</Popover>
							</div>
						</div>
						<div className="ml-1 flex items-center gap-2">
							<span className="text-muted-foreground text-[10px]">
								{t["ai_img2img.params_count"]}
							</span>
							<div className="bg-card flex overflow-hidden rounded-lg border">
								{([1, 2] as const).map((value) => (
									<ParamChip
										key={value}
										label={`${value}`}
										selected={numImages === value}
										disabled={running}
										onClick={() => setNumImages(value)}
									/>
								))}
							</div>
						</div>
					</section>

					{/* 底部行：成本（左）+ 生成（右，主色 + ⌘↵） */}
					<div className="flex items-center justify-between gap-3">
						<div className="text-muted-foreground text-[10.5px]">
							{model == null ? (
								<span className="text-amber-500">
									{t["ai_img2img.model_missing"]}
								</span>
							) : (
								<>
									{totalCost != null &&
										t["ai_img2img.cost_estimate"].replace(
											"{points}",
											String(totalCost),
										)}
									{" ｜ "}
									{t["ai_img2img.balance"].replace(
										"{points}",
										String(billing.balance ?? "—"),
									)}
									{billing.frozen != null && billing.frozen > 0 && (
										<span className="opacity-70">
											{" ｜ "}
											{t["billing.frozen_note"].replace(
												"{count}",
												String(billing.frozen),
											)}
										</span>
									)}
									{insufficient && (
										<span className="text-red-500">
											{" "}
											{t["ai_img2img.balance_low"]}
										</span>
									)}
								</>
							)}
						</div>
						<Button
							className="bg-primary hover:bg-primary/90 h-[34px] gap-1.5 rounded-lg px-5 text-xs text-white"
							disabled={!canGenerate}
							title="⌘↵ / Ctrl+↵"
							onClick={handleGenerate}
						>
							<Sparkles className="size-3.5" />
							{running ? (
								t["ai_img2img.generating"]
							) : (
								<>
									{t["ai_img2img.generate"]}
									<span className="text-[10px] opacity-70">（⌘↵）</span>
								</>
							)}
						</Button>
					</div>

					{/* ④ 结果横滑条带（完成即自动入库） */}
					{results.length > 0 && (
						<section>
							<div className="text-muted-foreground mx-0.5 mb-1 text-[10px]">
								{t["ai_img2img.results_title"]}
							</div>
							<div className="flex gap-2 overflow-x-auto pb-1">
								{results.map((result) => {
									if (result.status === "generating") {
										return (
											<div
												key={result.key}
												className="bg-secondary h-[66px] w-[88px] shrink-0 animate-pulse rounded-lg"
											/>
										);
									}
									if (result.status === "failed") {
										return (
											<div
												key={result.key}
												className="flex h-[66px] w-[88px] shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-red-900 p-1 text-center text-[9px] text-red-400"
											>
												<span>{t["ai_img2img.res_failed"]}</span>
												<button
													type="button"
													className="underline disabled:opacity-40"
													disabled={running}
													onClick={handleGenerate}
												>
													{t["ai_img2img.res_retry"]}
												</button>
											</div>
										);
									}
									const url = result.assetId
										? assetUrlById(result.assetId)
										: null;
									return (
										<div
											key={result.key}
											className="relative h-[66px] w-[88px] shrink-0 overflow-hidden rounded-lg border"
										>
											{url && (
												// eslint-disable-next-line @next/next/no-img-element
												<img
													src={url}
													alt={result.name}
													className="size-full object-cover"
												/>
											)}
											<div className="absolute inset-x-0 bottom-0 flex justify-around bg-black/60 py-0.5 text-[9px] text-zinc-300">
												{url && (
													<button
														type="button"
														onClick={() => setPreviewUrl(url)}
													>
														{t["ai_img2img.res_preview"]}
													</button>
												)}
												{result.assetId && (
													<button
														type="button"
														onClick={() =>
															onInsertTimeline(result.assetId as string)
														}
													>
														{t["ai_img2img.res_insert"]}
													</button>
												)}
												<button
													type="button"
													disabled={running}
													onClick={handleGenerate}
												>
													{t["ai_img2img.res_regenerate"]}
												</button>
											</div>
										</div>
									);
								})}
							</div>
						</section>
					)}
				</DialogContent>
			</Dialog>

			{/* 补图：素材库多选 */}
			<AiVideoMediaPickerDialog
				open={pickerOpen}
				assets={libraryImages}
				maxImageBytes={MAX_IMAGE_BYTES}
				mode="multi"
				max={IMG2IMG_MAX_SLOTS - slots.length}
				onClose={() => setPickerOpen(false)}
				onConfirm={() => {}}
				onConfirmMulti={({ assets: picked }) => {
					addSlots(filesToSlots(picked.map((asset) => asset.file)));
					setPickerOpen(false);
				}}
				onLocalUpload={() => {
					setPickerOpen(false);
					uploadRef.current?.click();
				}}
			/>

			{/* 大图预览 */}
			{previewUrl && (
				<div
					className="fixed inset-0 z-100 flex items-center justify-center bg-black/80 p-6"
					onClick={() => setPreviewUrl(null)}
					onKeyDown={(event) => {
						if (event.key === "Escape") setPreviewUrl(null);
					}}
					role="button"
					tabIndex={0}
				>
					{/* eslint-disable-next-line @next/next/no-img-element */}
					<img
						src={previewUrl}
						alt=""
						className="max-h-full max-w-full rounded-lg object-contain"
					/>
				</div>
			)}
		</>
	);
}

function SizeInput({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<label className="flex items-center gap-1 text-[11px]">
			<span className="text-muted-foreground">{label}</span>
			<input
				inputMode="numeric"
				value={value}
				className="border-border bg-card w-16 rounded-md border px-2 py-1 text-[11px] outline-none"
				onChange={(event) => onChange(event.target.value.replace(/[^\d]/g, ""))}
			/>
		</label>
	);
}

/** 吸附预览 / 越界提示。 */
function SizeHint({ draftW, draftH }: { draftW: string; draftH: string }) {
	const { t } = useLocale();
	const w = Number(draftW);
	const h = Number(draftH);
	const applied = validateCustomSize(w, h);
	const { minEdge, maxEdge, step, maxPixels } = IMG2IMG_SIZE_CAPS;
	if (!applied) {
		return (
			<div className="mt-2 text-[10px] text-red-400">
				{t["ai_img2img.size_invalid"]
					.replace("{min}", String(minEdge))
					.replace("{max}", String(maxEdge))
					.replace("{maxPixels}", `${maxEdge}×${maxEdge}`)}
			</div>
		);
	}
	return (
		<div className="text-blue-300 mt-2 text-[10px]">
			{t["ai_img2img.size_snap_applied"]
				.replace("{size}", `${applied.w}×${applied.h}`)
				.replace("{step}", String(step))
				.replace("{maxEdge}", String(maxEdge))
				.replace("{maxPixels}", `${maxEdge}×${maxEdge}`)}
		</div>
	);
}

/** Radix PopoverTrigger 的 asChild 需要 ref 且会透传 aria/data-* 与事件，因此必须展开 rest。 */
const ParamChip = React.forwardRef<
	HTMLButtonElement,
	React.ComponentPropsWithoutRef<"button"> & {
		label: string;
		selected: boolean;
	}
>(function ParamChip({ label, selected, className, ...rest }, ref) {
	return (
		<button
			ref={ref}
			type="button"
			className={cn(
				"px-2 py-1 text-[10px] whitespace-nowrap transition-colors disabled:opacity-50",
				selected
					? "bg-primary text-white"
					: "text-muted-foreground hover:text-foreground",
				className,
			)}
			{...rest}
		>
			{label}
		</button>
	);
});
