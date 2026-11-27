"use client";

/**
 * 文生图对话框（入口：素材库头部工具栏「生图」按钮，多图生成左侧）。
 *
 * 布局对齐多图生图对话框：提示词（⌘↵ 生成）→ 灵感 chips → 风格预设
 * → 高级（负面词）→ 比例/尺寸/数量分段 → 成本 + 生成 → 结果横滑条带
 * + 最近生成网格。生成会话状态在 text2img-store，关闭对话框不中断；
 * 时间轴插入由宿主注入（与多图生图同款落播放头逻辑）。
 * 尺寸能力常量与校验复用 img2img-store，不另设一套。
 */

import { useState } from "react";
import { Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { useEditor } from "@/editor/use-editor";
import { useLocale } from "@/locale/locale-context";
import type { LocaleKey } from "@/locale";
import { estimateCost, useBilling } from "@/services/billing/client";
import {
	getText2ImgStyleSuffix,
	useText2ImgStore,
	type Text2ImgHistoryItem,
	type Text2ImgNumImages,
	type Text2ImgStyleKey,
} from "./text2img-store";
import { resolveImageRequestSize } from "./image-size";
import { TEXT2IMG_MODEL_OPTIONS } from "./image-model-options";
import {
	validateCustomSize,
	type Img2ImgAspectRatio,
} from "./img2img-store";
import { ParamChip, SizeHint, SizeInput } from "./param-controls";
import { cn } from "@/utils/ui";

const ASPECTS: Img2ImgAspectRatio[] = ["1:1", "16:9", "3:4", "9:16"];
// 长边档：768 档放大后与 1024 档重合，故不提供
const SIZE_PRESETS: Array<1024 | 1536> = [1024, 1536];
const COUNTS: Text2ImgNumImages[] = [1, 2, 4];

const STYLE_OPTIONS: Array<{
	key: Text2ImgStyleKey;
	labelKey: LocaleKey;
}> = [
	{ key: "none", labelKey: "ai_t2i.style_none" },
	{ key: "photo", labelKey: "ai_t2i.style_photo" },
	{ key: "illustration", labelKey: "ai_t2i.style_illustration" },
	{ key: "3d", labelKey: "ai_t2i.style_3d" },
	{ key: "anime", labelKey: "ai_t2i.style_anime" },
	{ key: "ink", labelKey: "ai_t2i.style_ink" },
];

/** 灵感模板：点击把模板句追加进提示词（文案随界面语言）。 */
const IDEA_TEMPLATES: Array<{ key: LocaleKey; zh: string; en: string }> = [
	{
		key: "ai_t2i.idea_cine",
		zh: "电影感构图与光影，宽画幅，",
		en: "cinematic composition and lighting, widescreen, ",
	},
	{
		key: "ai_t2i.idea_poster",
		zh: "极简主义海报构图，大面积留白，",
		en: "minimalist poster composition, generous negative space, ",
	},
	{
		key: "ai_t2i.idea_picturebook",
		zh: "儿童绘本插画风格，柔和色彩，",
		en: "children's picture book illustration, soft colors, ",
	},
	{
		key: "ai_t2i.idea_cyberpunk",
		zh: "赛博朋克未来城市，霓虹灯夜景，",
		en: "cyberpunk future city, neon night scene, ",
	},
	{
		key: "ai_t2i.idea_product",
		zh: "产品摄影，纯白背景，柔和布光，",
		en: "product photography, pure white background, soft lighting, ",
	},
];

export function Text2ImgDialog({
	onInsertTimeline,
}: {
	onInsertTimeline: (assetId: string) => void;
}) {
	const { t, locale } = useLocale();
	const billing = useBilling();
	const editor = useEditor();
	const activeProject = useEditor((e) => e.project.getActive());
	// 响应式快照：入库/删除素材时结果卡与历史卡的缩略图随之刷新
	const mediaAssets = useEditor((e) => e.media.getAssets());
	const {
		open,
		modelId,
		prompt,
		style,
		negative,
		aspectRatio,
		sizePreset,
		customSize,
		numImages,
		running,
		results,
		history,
		close,
		setModelId,
		setPrompt,
		setStyle,
		setNegative,
		setAspectRatio,
		setSizePreset,
		setCustomSize,
		setNumImages,
		generate,
	} = useText2ImgStore();

	const [customOpen, setCustomOpen] = useState(false);
	const [advOpen, setAdvOpen] = useState(false);
	const [draftW, setDraftW] = useState("1024");
	const [draftH, setDraftH] = useState("1024");
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);

	// 打开自定义弹层时，以当前生效尺寸作为草稿初值（避免 effect 里同步 setState）
	const handleCustomOpenChange = (next: boolean) => {
		setCustomOpen(next);
		if (!next) return;
		const current = resolveImageRequestSize({ aspectRatio, sizePreset, customSize });
		setDraftW(String(current.w));
		setDraftH(String(current.h));
	};

	const assetUrlById = (assetId: string): string | null =>
		mediaAssets.find((asset) => asset.id === assetId)?.url ?? null;

	const model = billing.models.get(modelId);
	const costPerCall = model
		? estimateCost({ model, resolution: "720p", seconds: 1 })
		: null;
	const totalCost = costPerCall != null ? costPerCall * numImages : null;
	const insufficient =
		billing.balance != null && totalCost != null && totalCost > billing.balance;

	const canGenerate =
		!running &&
		activeProject != null &&
		prompt.trim().length > 0 &&
		model != null &&
		!insufficient;

	// 自定义档展示的也是放大后的生效尺寸（所见 = 实际提交）
	const effectiveCustomSize =
		sizePreset === "custom" && customSize
			? resolveImageRequestSize({ aspectRatio, sizePreset, customSize })
			: null;

	// 模型选项只展示 billing 已收录的（渠道/价格已配置的才会出现）
	const modelOptions = TEXT2IMG_MODEL_OPTIONS.filter(
		(option) => billing.models.get(option.id) != null,
	);

	const importAsset = async ({
		file,
		name,
	}: {
		file: File;
		name: string;
	}): Promise<string | null> => {
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

	const runGenerate = () => {
		void generate({
			locale,
			importAsset,
			onFinished: (imported) => {
				if (imported > 0) {
					void billing.refreshBalance();
					toast.success(t["ai_t2i.done_toast"].replace("{n}", String(imported)));
				}
			},
		});
	};

	const handleGenerate = () => {
		if (!canGenerate) return;
		runGenerate();
	};

	/** 历史「再来一张」：提示词回填 + 同参数直接生成（store.set 是同步的，generate 读到新值）。 */
	const handleRegenerateFromHistory = (item: Text2ImgHistoryItem) => {
		if (running || insufficient) return;
		setPrompt(item.prompt);
		runGenerate();
	};

	const handleInsert = (assetId: string) => {
		onInsertTimeline(assetId);
		toast.success(t["ai_t2i.inserted"]);
	};

	const appendIdea = (template: { zh: string; en: string }) => {
		const text = locale === "zh" ? template.zh : template.en;
		setPrompt(prompt.trim() ? `${prompt.trim()} ${text}` : text);
	};

	const applyCustomSize = () => {
		const parsed = validateCustomSize(Number(draftW), Number(draftH));
		if (!parsed) return;
		setCustomSize({ w: parsed.w, h: parsed.h });
		setCustomOpen(false);
	};

	const styleSuffix = getText2ImgStyleSuffix({ style, locale });

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
							{t["ai_t2i.title"]}
						</DialogTitle>
					</DialogHeader>

					{/* ⓪ 模型（billing 已收录的才会出现；单选项时固定展示） */}
					{modelOptions.length > 0 && (
						<section>
							<div className="text-muted-foreground mx-0.5 mb-1 text-[10px]">
								{t["ai_t2i.model_label"]}
							</div>
							<div className="flex flex-wrap gap-1.5">
								{modelOptions.map((option) => (
									<button
										key={option.id}
										type="button"
										disabled={running}
										className={cn(
											"rounded-full border px-2 py-0.5 text-[10px] transition-colors disabled:opacity-50",
											modelId === option.id
												? "border-primary bg-primary text-white"
												: "border-border text-muted-foreground hover:text-foreground",
										)}
										onClick={() => setModelId(option.id)}
									>
										{t[option.labelKey]}
									</button>
								))}
							</div>
						</section>
					)}

					{/* ① 提示词（灵感 chips · ⌘↵ 生成） */}
					<section>
						<div className="text-muted-foreground mx-0.5 mb-1 flex items-center justify-between text-[10px]">
							<span>{t["ai_t2i.prompt_label"]}</span>
							<span>{prompt.length}/2000</span>
						</div>
						<textarea
							value={prompt}
							maxLength={2000}
							placeholder={t["ai_t2i.prompt_placeholder"]}
							className="border-border focus:ring-ring placeholder:text-muted-foreground/70 min-h-[90px] w-full resize-none rounded-lg border bg-transparent px-2 py-2 text-[11px] leading-relaxed outline-none"
							onChange={(event) => setPrompt(event.target.value)}
							onKeyDown={(event) => {
								if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
									event.preventDefault();
									handleGenerate();
								}
							}}
						/>
						<div className="text-muted-foreground mx-0.5 mt-2 mb-1 text-[10px]">
							{t["ai_t2i.idea_label"]}
						</div>
						<div className="flex flex-wrap gap-1.5">
							{IDEA_TEMPLATES.map((template) => (
								<button
									key={template.key}
									type="button"
									disabled={running}
									className="border-border text-muted-foreground hover:text-foreground rounded-full border px-2 py-0.5 text-[10px] transition-colors disabled:opacity-50"
									onClick={() => appendIdea(template)}
								>
									{t[template.key]}
								</button>
							))}
						</div>
					</section>

					{/* ② 风格预设（单选，可取消；生成时拼接后缀） */}
					<section>
						<div className="text-muted-foreground mx-0.5 mb-1 text-[10px]">
							{t["ai_t2i.style_label"]}
						</div>
						<div className="flex flex-wrap gap-1.5">
							{STYLE_OPTIONS.map((option) => (
								<button
									key={option.key}
									type="button"
									disabled={running}
									className={cn(
										"rounded-full border px-2 py-0.5 text-[10px] transition-colors disabled:opacity-50",
										style === option.key
											? "border-primary bg-primary text-white"
											: "border-border text-muted-foreground hover:text-foreground",
									)}
									onClick={() => setStyle(option.key)}
								>
									{t[option.labelKey]}
								</button>
							))}
						</div>
						<div className="text-muted-foreground/70 mx-0.5 mt-1.5 text-[10px]">
							{styleSuffix
								? t["ai_t2i.style_hint_on"].replace("{suffix}", styleSuffix)
								: t["ai_t2i.style_hint_none"]}
						</div>
					</section>

					{/* ③ 高级：负面提示词（默认收起） */}
					<section>
						<button
							type="button"
							className="text-muted-foreground hover:text-foreground text-[10px]"
							onClick={() => setAdvOpen(!advOpen)}
						>
							{advOpen ? "▾" : "▸"} {t["ai_t2i.advanced"]}
						</button>
						{advOpen && (
							<div className="mt-2">
								<div className="text-muted-foreground mx-0.5 mb-1 text-[10px]">
									{t["ai_t2i.negative_label"]}
								</div>
								<textarea
									value={negative}
									maxLength={500}
									placeholder={t["ai_t2i.negative_placeholder"]}
									className="border-border focus:ring-ring placeholder:text-muted-foreground/70 min-h-[46px] w-full resize-none rounded-lg border bg-transparent px-2 py-2 text-[11px] leading-relaxed outline-none"
									onChange={(event) => setNegative(event.target.value)}
								/>
							</div>
						)}
					</section>

					{/* ④ 参数：比例 / 尺寸 / 数量（分段控件，样式对齐素材面板） */}
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
									const size = resolveImageRequestSize({
										aspectRatio,
										sizePreset: preset,
										customSize,
									});
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
								<Popover open={customOpen} onOpenChange={handleCustomOpenChange}>
									<PopoverTrigger asChild disabled={running}>
										<ParamChip
											label={
												effectiveCustomSize
													? `${effectiveCustomSize.w}×${effectiveCustomSize.h}`
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
							<div className="text-muted-foreground/70 mx-0.5 mt-1 text-[9.5px]">
								{t["ai_t2i.size_min_note"]}
							</div>
							<div className="ml-1 mt-1 flex items-center gap-2">
								<span className="text-muted-foreground text-[10px]">
									{t["ai_img2img.params_count"]}
								</span>
							<div className="bg-card flex overflow-hidden rounded-lg border">
								{COUNTS.map((value) => (
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
									{t["ai_t2i.model_missing"]}
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

					{/* ⑤ 结果横滑条带（完成即自动入库） */}
					{results.length > 0 && (
						<section>
							<div className="text-muted-foreground mx-0.5 mb-1 text-[10px]">
								{t["ai_t2i.results_title"]}
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
									const assetId = result.assetId;
									const url = assetId ? assetUrlById(assetId) : null;
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
												{assetId && (
													<button
														type="button"
														onClick={() => handleInsert(assetId)}
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

					{/* ⑥ 最近生成（会话级；素材库为持久层） */}
					<section>
						<div className="text-muted-foreground mx-0.5 mb-1 text-[10px]">
							{t["ai_t2i.history_title"]}
						</div>
						{history.length === 0 ? (
							<div className="border-border/70 text-muted-foreground/70 rounded-lg border border-dashed px-3 py-3 text-center text-[10.5px] leading-relaxed">
								{t["ai_t2i.empty_history"]}
							</div>
						) : (
							<div className="grid grid-cols-4 gap-1.5">
								{history.slice(0, 8).map((item) => {
									const url = item.assetId ? assetUrlById(item.assetId) : null;
									return (
										<div
											key={item.key}
											className="group relative cursor-pointer overflow-hidden rounded-lg border"
											title={item.prompt}
											onClick={() => {
												if (url) setPreviewUrl(url);
											}}
											onKeyDown={(event) => {
												if (event.key === "Enter" && url) setPreviewUrl(url);
											}}
											role="button"
											tabIndex={0}
										>
											{url ? (
												// eslint-disable-next-line @next/next/no-img-element
												<img
													src={url}
													alt={item.name}
													className="h-[52px] w-full object-cover"
												/>
											) : (
												<div className="bg-secondary h-[52px] w-full" />
											)}
											<button
												type="button"
												aria-label={t["ai_t2i.res_regenerate_one"]}
												title={t["ai_t2i.res_regenerate_one"]}
												disabled={running || !prompt.trim()}
												className="absolute top-0.5 right-0.5 rounded bg-black/60 px-1 text-[9px] leading-[14px] text-white/80 transition-colors hover:text-white disabled:opacity-30"
												onClick={(event) => {
													event.stopPropagation();
													handleRegenerateFromHistory(item);
												}}
											>
												↻
											</button>
											<div className="px-1 pt-0.5 pb-1">
												<div className="truncate text-[9px]">{item.prompt}</div>
												<div className="text-muted-foreground text-[8.5px] opacity-80">
													{item.aspectRatio} · {item.width}×{item.height}
												</div>
											</div>
										</div>
									);
								})}
							</div>
						)}
					</section>
				</DialogContent>
			</Dialog>

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
