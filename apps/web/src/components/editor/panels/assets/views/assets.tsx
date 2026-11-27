"use client";
import { useLocale } from "@/locale/locale-context";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { MediaDragOverlay } from "@/components/editor/panels/assets/drag-overlay";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { DEFAULT_NEW_ELEMENT_DURATION } from "@/timeline/creation";
import { mediaTimeFromSeconds, type MediaTime } from "@/wasm";
import { useEditor } from "@/editor/use-editor";
import { useFileUpload } from "@/media/use-file-upload";
import { invokeAction } from "@/actions";
import { processMediaAssets } from "@/media/processing";
import { showMediaUploadToast } from "@/media/upload-toast";
import {
	SelectableItem,
	SelectableSurface,
	useSelection,
	useSelectionContext,
	useSelectionScope,
} from "@/selection";
import { buildElementFromMedia } from "@/timeline/element-utils";
import { Sparkles } from "lucide-react";
import { MultiImg2ImgDialog } from "@/components/ai/img2img-dialog";
import {
	useImg2ImgStore,
	type Img2ImgSlot,
} from "@/components/ai/img2img-store";
import { Text2ImgDialog } from "@/components/ai/text2img-dialog";
import { useText2ImgStore } from "@/components/ai/text2img-store";
import {
	type MediaSortKey,
	type MediaSortOrder,
	type MediaViewMode,
	useAssetsPanelStore,
} from "@/components/editor/panels/assets/assets-panel-store";
import { MASKABLE_ELEMENT_TYPES } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { cn } from "@/utils/ui";
import {
	CloudUploadIcon,
	GridViewIcon,
	LeftToRightListDashIcon,
	SortingOneNineIcon,
	Image02Icon,
	MusicNote03Icon,
	Video01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";

export function MediaView() {
	const editor = useEditor();
	const mediaFiles = useEditor((e) => e.media.getAssets());
	const activeProject = useEditor((e) => e.project.getActive());
	const { t } = useLocale();

	const {
		mediaViewMode,
		setMediaViewMode,
		highlightMediaId,
		clearHighlight,
		mediaSortBy,
		mediaSortOrder,
		setMediaSort,
	} = useAssetsPanelStore();

	const [isProcessing, setIsProcessing] = useState(false);
	const [progress, setProgress] = useState(0);

	const processFiles = async ({ files }: { files: File[] }) => {
		if (!files || files.length === 0) return;
		if (!activeProject) {
			toast.error(t["toast.no_active_project"]);
			return;
		}

		setIsProcessing(true);
		setProgress(0);
		try {
			await showMediaUploadToast({
				filesCount: files.length,
				t,
				promise: async () => {
					const processedAssets = await processMediaAssets({
						files,
						onProgress: (progress: { progress: number }) =>
							setProgress(progress.progress),
					});
					for (const asset of processedAssets) {
						await editor.media.addMediaAsset({
							projectId: activeProject.metadata.id,
							asset,
						});
					}
					return {
						uploadedCount: processedAssets.length,
						assetNames: processedAssets.map((asset) => asset.name),
					};
				},
			});
		} catch (error) {
			console.error("Error processing files:", error);
		} finally {
			setIsProcessing(false);
			setProgress(0);
		}
	};

	const { isDragOver, dragProps, openFilePicker, fileInputProps } =
		useFileUpload({
			accept: "image/*,video/*,audio/*",
			multiple: true,
			onFilesSelected: (files) => processFiles({ files }),
		});

	const handleRemove = ({
		event,
		ids,
	}: {
		event: React.MouseEvent;
		ids: string[];
	}) => {
		event.stopPropagation();

		invokeAction("remove-media-assets", {
			projectId: activeProject.metadata.id,
			assetIds: ids,
		});
	};

	const handleSort = ({ key }: { key: MediaSortKey }) => {
		if (mediaSortBy === key) {
			setMediaSort({
				key,
				order: mediaSortOrder === "asc" ? "desc" : "asc",
			});
		} else {
			setMediaSort({ key, order: "asc" });
		}
	};

	const filteredMediaItems = useMemo(() => {
		const filtered = mediaFiles.filter((item) => !item.ephemeral);

		filtered.sort((a, b) => {
			let comparison: number;

			switch (mediaSortBy) {
				case "name":
					comparison = (a.name || "")
						.toLowerCase()
						.localeCompare((b.name || "").toLowerCase());
					break;
				case "type":
					comparison = a.type.localeCompare(b.type);
					break;
				case "duration":
					comparison = (a.duration || 0) - (b.duration || 0);
					break;
				case "size":
					comparison = a.file.size - b.file.size;
					break;
				default:
					return 0;
			}

			return mediaSortOrder === "asc" ? comparison : -comparison;
		});

		return filtered;
	}, [mediaFiles, mediaSortBy, mediaSortOrder]);
	const orderedMediaIds = useMemo(() => {
		return filteredMediaItems.map((item) => item.id);
	}, [filteredMediaItems]);

	const img2img = useImg2ImgStore();
	// 文生图入口：只订阅按钮需要的字段，避免对话框里输入提示词时重排素材列表
	const t2iRunning = useText2ImgStore((state) => state.running);
	const t2iOpen = useText2ImgStore((state) => state.open);
	const openText2Img = useText2ImgStore((state) => state.setOpen);
	// 多选模式：点击素材只做选中切换（多图生图用），不再触发插入时间轴；
	// 退出后恢复原生点击行为。普通模式完全不受影响。
	const [selectMode, setSelectMode] = useState(false);

	/** 打开对话框：有进行中的会话则恢复，否则用当前选中的图片预填。 */
	const openImg2Img = (images: MediaAsset[]) => {
		if (img2img.running || img2img.results.length > 0) {
			img2img.setOpen(true);
			return;
		}
		const slots: Img2ImgSlot[] = images.map((asset) => ({
			key: `${asset.id}-${Date.now()}`,
			name: asset.name,
			file: asset.file,
			previewUrl: asset.url ?? URL.createObjectURL(asset.file),
			fromAssetId: asset.id,
		}));
		img2img.openWith(slots);
	};

	/** 结果卡「插时间轴」：图元素落到播放头位置。 */
	const handleImg2ImgInsert = (assetId: string) => {
		const asset = editor.media.getAssets().find((item) => item.id === assetId);
		if (!asset || !activeProject) return;
		const element = buildElementFromMedia({
			mediaId: asset.id,
			mediaType: asset.type,
			name: asset.name,
			duration: DEFAULT_NEW_ELEMENT_DURATION,
			startTime: editor.playback.getCurrentTime(),
		});
		editor.timeline.insertElement({
			element,
			placement: { mode: "auto" },
		});
	};

	return (
		<>
			<input {...fileInputProps} />
			<MultiImg2ImgDialog onInsertTimeline={handleImg2ImgInsert} />
			<Text2ImgDialog onInsertTimeline={handleImg2ImgInsert} />

			<PanelView
				title={t["assets.assets"]}
				actions={
					<div className="flex items-center gap-1.5">
						{!selectMode && (
							<Button
								size="sm"
								variant="ghost"
								className="h-8 gap-1.5 px-2 text-xs"
								title={t["ai_t2i.title"]}
								onClick={() => openText2Img(true)}
							>
								<Sparkles className="size-3.5" />
								{t["ai_t2i.entry"]}
								{t2iRunning && !t2iOpen && (
									// 生成中且对话框已关：入口呼吸点提示，点击重开查看进度
									<span
										aria-hidden
										className="ml-0.5 size-1.5 animate-pulse rounded-full bg-emerald-500"
									/>
								)}
							</Button>
						)}
						<Button
							size="sm"
							variant={selectMode ? "default" : "ghost"}
							className="h-8 px-2 text-xs"
							onClick={() => setSelectMode(!selectMode)}
						>
							{selectMode
								? t["assets.multi_select_exit"]
								: t["assets.multi_select"]}
						</Button>
						<MediaActions
							mediaViewMode={mediaViewMode}
							setMediaViewMode={setMediaViewMode}
							isProcessing={isProcessing}
							sortBy={mediaSortBy}
							sortOrder={mediaSortOrder}
							onSort={handleSort}
							onImport={openFilePicker}
						/>
					</div>
				}
				className={cn(isDragOver && "bg-accent/30")}
				contentClassName="h-full"
				{...dragProps}
			>
				{isDragOver || filteredMediaItems.length === 0 ? (
					<MediaDragOverlay
						isVisible={true}
						isProcessing={isProcessing}
						progress={progress}
						onClick={openFilePicker}
					/>
				) : (
					<SelectableSurface
						ariaLabel={t["assets.assets"]}
						orderedIds={orderedMediaIds}
						revealId={highlightMediaId}
						onRevealComplete={clearHighlight}
					>
						<MediaScopeRegistrar />
						<MediaItemList
							items={filteredMediaItems}
							mode={mediaViewMode}
							onRemove={handleRemove}
							selectMode={selectMode}
						/>
						{selectMode && (
							<Img2ImgBatchBar
								items={filteredMediaItems}
								onOpen={openImg2Img}
								onExit={() => setSelectMode(false)}
							/>
						)}
						{selectMode && (
							<SelectModeEffects onExit={() => setSelectMode(false)} />
						)}
					</SelectableSurface>
				)}
			</PanelView>
		</>
	);
}

function MediaScopeRegistrar() {
	useSelectionScope();
	return null;
}

/** 多选模式的随行副作用：ESC = 清空选择并退出多选；退出时顺带清空选中。 */
function SelectModeEffects({ onExit }: { onExit: () => void }) {
	const { clearSelection } = useSelection();
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				clearSelection();
				onExit();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => {
			window.removeEventListener("keydown", onKey);
			// 任何方式退出多选（按钮/ESC/切面板）都收掉选中集合
			clearSelection();
		};
	}, [clearSelection, onExit]);
	return null;
}

/**
 * 素材库批量动作条（仅多选模式渲染）：sticky 在滚动容器底部。
 * 多图生图要求 2~4 张图片——不足/超出时按钮置灰并给出补选文案；
 * 只统计图片，视频选中不拦截（可能还在用于批量删除）。
 */
function Img2ImgBatchBar({
	items,
	onOpen,
	onExit,
}: {
	items: MediaAsset[];
	onOpen: (images: MediaAsset[]) => void;
	onExit: () => void;
}) {
	const { t } = useLocale();
	const { selectedIds, clearSelection } = useSelection();

	const selected = items.filter((item) => selectedIds.includes(item.id));
	const images = selected.filter((item) => item.type === "image");
	const videos = selected.length - images.length;
	if (selected.length === 0) return null;

	const tooFew = images.length < 2;
	const tooMany = images.length > 4;
	const canOpen = !tooFew && !tooMany;
	const hint = tooFew
		? t["ai_img2img.bar_need_more"].replace("{n}", String(2 - images.length))
		: tooMany
			? t["ai_img2img.bar_too_many"].replace("{n}", String(images.length - 4))
			: null;

	return (
		// Purely an event-isolation wrapper so bar interactions do not reach the
		// selection surface behind it; presentation keeps it out of the a11y tree.
		<div
			role="presentation"
			className="sticky bottom-1 z-10 mt-2"
			onMouseDown={(event) => event.stopPropagation()}
			onClick={(event) => event.stopPropagation()}
		>
			<div className="bg-background/95 border-border flex items-center justify-between gap-2 rounded-lg border px-2.5 py-1.5 shadow-sm backdrop-blur">
				<span className="text-muted-foreground truncate text-[11px]">
					{t["ai_img2img.bar_images"].replace("{n}", String(images.length))}
					{videos > 0 &&
						` · ${t["ai_img2img.bar_videos_ignored"].replace("{n}", String(videos))}`}
				</span>
				<div className="flex shrink-0 items-center gap-2">
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground rounded px-1 text-[11px]"
						onClick={clearSelection}
					>
						{t["ai_img2img.bar_clear"]}
					</button>
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground rounded px-1 text-[11px]"
						onClick={() => {
							clearSelection();
							onExit();
						}}
					>
						{t["assets.multi_select_exit"]}
					</button>
					<Button
						size="sm"
						className="h-7 px-2.5 text-[11px]"
						disabled={!canOpen}
						title={hint ?? undefined}
						onClick={() => onOpen(images)}
					>
						{hint ?? t["ai_img2img.bar_action"]}
					</Button>
				</div>
			</div>
		</div>
	);
}

function MediaAssetDraggable({
	item,
	preview,
	variant,
	isRounded,
	isDraggable = true,
}: {
	item: MediaAsset;
	preview: React.ReactNode;
	variant: "card" | "compact";
	isRounded?: boolean;
	/** 多选模式下禁用拖拽与点击插入，点击只做选中切换。 */
	isDraggable?: boolean;
}) {
	const editor = useEditor();
	const { t } = useLocale();

	const addElementAtTime = ({
		asset,
		startTime,
	}: {
		asset: MediaAsset;
		startTime: MediaTime;
	}) => {
		const duration =
			asset.duration != null
				? mediaTimeFromSeconds({ seconds: asset.duration })
				: DEFAULT_NEW_ELEMENT_DURATION;
		const element = buildElementFromMedia({
			mediaId: asset.id,
			mediaType: asset.type,
			name: asset.name,
			duration,
			startTime,
		});
		editor.timeline.insertElement({
			element,
			placement: { mode: "auto" },
		});
	};

	return (
		<DraggableItem
			name={item.name}
			preview={preview}
			dragData={{
				id: item.id,
				type: "media",
				mediaType: item.type,
				name: item.name,
				...(item.type !== "audio" && {
					targetElementTypes: [...MASKABLE_ELEMENT_TYPES],
				}),
			}}
			shouldShowPlusOnDrag={false}
			onAddToTimeline={({ currentTime }) =>
				addElementAtTime({ asset: item, startTime: currentTime })
			}
			variant={variant}
			isRounded={isRounded}
			isDraggable={isDraggable}
			// 素材卡的「＋」常显：触屏/内嵌 webview 没有 hover，(hover:hover)
			// 下的 group-hover 会永远不触发，用户就找不到添加到时间轴的入口。
			// 常显时放右上角，右下角留给视频时长角标。
			plusClassName={isDraggable ? "opacity-80 shadow-sm hover:opacity-100" : "hidden"}
			plusPlacement="top-right"
			plusTitle={t["common.add_to_timeline"]}
		/>
	);
}

function MediaItemWithContextMenu({
	item,
	children,
	onRemove,
}: {
	item: MediaAsset;
	children: React.ReactNode;
	onRemove: ({
		event,
		ids,
	}: {
		event: React.MouseEvent;
		ids: string[];
	}) => void;
}) {
	const { isSelected, selectedIds } = useSelection();
	const { t } = useLocale();
	const idsToDelete = isSelected(item.id) ? selectedIds : [item.id];
	const deleteLabel =
		idsToDelete.length > 1
			? t["media.delete_items"].replace("{count}", String(idsToDelete.length))
			: t["common.delete"];

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem>{t["media.export_clips"]}</ContextMenuItem>
				<ContextMenuItem
					variant="destructive"
					onClick={(event: React.MouseEvent<HTMLDivElement>) =>
						onRemove({ event, ids: idsToDelete })
					}
				>
					{deleteLabel}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

function MediaItemList({
	items,
	mode,
	onRemove,
	selectMode = false,
}: {
	items: MediaAsset[];
	mode: MediaViewMode;
	onRemove: ({
		event,
		ids,
	}: {
		event: React.MouseEvent;
		ids: string[];
	}) => void;
	/** 多选模式：点击素材=切换选中（不触发插入时间轴）。 */
	selectMode?: boolean;
}) {
	const isGrid = mode === "grid";
	const { handleItemClick } = useSelectionContext();
	const { isSelected } = useSelection();

	/** 多选模式下的点击：capture 阶段拦下，原生「点击=插时间轴」不触发。 */
	const toggleSelected = (event: React.MouseEvent, id: string) => {
		event.preventDefault();
		event.stopPropagation();
		handleItemClick({
			event: {
				ctrlKey: true,
				shiftKey: false,
			} as React.MouseEvent<HTMLDivElement>,
			id,
		});
	};

	return (
		<div
			className={cn(isGrid ? "grid gap-4" : "flex flex-col gap-1.5")}
			style={
				isGrid ? { gridTemplateColumns: "repeat(auto-fill, 7rem)" } : undefined
			}
		>
			{items.map((item) => (
				<MediaItemWithContextMenu item={item} onRemove={onRemove} key={item.id}>
					<SelectableItem
						className={cn(!isGrid && "w-full")}
						id={item.id}
						onClickCapture={
							selectMode ? (event) => toggleSelected(event, item.id) : undefined
						}
					>
						<div className="relative">
							<MediaAssetDraggable
								item={item}
								preview={
									<MediaPreview
										item={item}
										variant={isGrid ? "grid" : "compact"}
									/>
								}
								variant={isGrid ? "card" : "compact"}
								isRounded={isGrid ? false : undefined}
								isDraggable={!selectMode}
							/>
							{selectMode && (
								<span
									className={cn(
										"pointer-events-none absolute top-1 right-1 z-10 flex size-4 items-center justify-center rounded-full border text-[9px] text-white",
										isSelected(item.id)
											? "border-primary bg-primary"
											: "border-white/70 bg-black/30",
									)}
								>
									{isSelected(item.id) ? "✓" : ""}
								</span>
							)}
						</div>
					</SelectableItem>
				</MediaItemWithContextMenu>
			))}
		</div>
	);
}

function formatDuration({ duration }: { duration: number }) {
	const min = Math.floor(duration / 60);
	const sec = Math.floor(duration % 60);
	return `${min}:${sec.toString().padStart(2, "0")}`;
}

function MediaDurationBadge({ duration }: { duration?: number }) {
	if (!duration) return null;

	return (
		<div className="absolute right-1 bottom-1 rounded bg-black/70 px-1 text-xs text-white">
			{formatDuration({ duration })}
		</div>
	);
}

function MediaDurationLabel({ duration }: { duration?: number }) {
	if (!duration) return null;

	return (
		<span className="text-xs opacity-70">{formatDuration({ duration })}</span>
	);
}

function MediaTypePlaceholder({
	icon,
	label,
	duration,
	variant,
}: {
	icon: IconSvgElement;
	label: string;
	duration?: number;
	variant: "muted" | "bordered";
}) {
	const iconClassName = cn("size-6", variant === "bordered" && "mb-1");

	return (
		<div
			className={cn(
				"text-muted-foreground flex size-full flex-col items-center justify-center rounded",
				variant === "muted" ? "bg-muted/30" : "border",
			)}
		>
			<HugeiconsIcon icon={icon} className={iconClassName} />
			<span className="text-xs">{label}</span>
			<MediaDurationLabel duration={duration} />
		</div>
	);
}

function MediaPreview({
	item,
	variant = "grid",
}: {
	item: MediaAsset;
	variant?: "grid" | "compact";
}) {
	const { t } = useLocale();
	const shouldShowDurationBadge = variant === "grid";

	if (item.type === "image") {
		return (
			<div className="relative flex size-full items-center justify-center bg-muted">
				<Image
					src={item.url ?? ""}
					alt={item.name}
					fill
					sizes="100vw"
					className="object-cover"
					loading="lazy"
					unoptimized
				/>
			</div>
		);
	}

	if (item.type === "video") {
		if (item.thumbnailUrl) {
			return (
				<div className="relative size-full">
					<Image
						src={item.thumbnailUrl}
						alt={item.name}
						fill
						sizes="100vw"
						className="rounded object-cover"
						loading="lazy"
						unoptimized
					/>
					{shouldShowDurationBadge ? (
						<MediaDurationBadge duration={item.duration} />
					) : null}
				</div>
			);
		}

		return (
			<MediaTypePlaceholder
				icon={Video01Icon}
				label={t["media.video"]}
				duration={item.duration}
				variant="muted"
			/>
		);
	}

	if (item.type === "audio") {
		return (
			<MediaTypePlaceholder
				icon={MusicNote03Icon}
				label={t["media.audio"]}
				duration={item.duration}
				variant="bordered"
			/>
		);
	}

	return (
		<MediaTypePlaceholder
			icon={Image02Icon}
			label={t["common.unknown"]}
			variant="muted"
		/>
	);
}

function MediaActions({
	mediaViewMode,
	setMediaViewMode,
	isProcessing,
	sortBy,
	sortOrder,
	onSort,
	onImport,
}: {
	mediaViewMode: MediaViewMode;
	setMediaViewMode: (mode: MediaViewMode) => void;
	isProcessing: boolean;
	sortBy: MediaSortKey;
	sortOrder: MediaSortOrder;
	onSort: ({ key }: { key: MediaSortKey }) => void;
	onImport: () => void;
}) {
	const { t } = useLocale();
	return (
		<div className="flex gap-1.5">
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							size="icon"
							variant="ghost"
							onClick={() =>
								setMediaViewMode(mediaViewMode === "grid" ? "list" : "grid")
							}
							disabled={isProcessing}
							className="items-center justify-center"
						>
							{mediaViewMode === "grid" ? (
								<HugeiconsIcon icon={LeftToRightListDashIcon} />
							) : (
								<HugeiconsIcon icon={GridViewIcon} />
							)}
						</Button>
					</TooltipTrigger>
					<TooltipContent>
						<p>
							{mediaViewMode === "grid"
								? t["assets.switch_to_list_view"]
								: t["assets.switch_to_grid_view"]}
						</p>
					</TooltipContent>
				</Tooltip>
				<Tooltip>
					<DropdownMenu>
						<TooltipTrigger asChild>
							<DropdownMenuTrigger asChild>
								<Button
									size="icon"
									variant="ghost"
									disabled={isProcessing}
									className="items-center justify-center"
								>
									<HugeiconsIcon icon={SortingOneNineIcon} />
								</Button>
							</DropdownMenuTrigger>
						</TooltipTrigger>
						<DropdownMenuContent align="end">
							<SortMenuItem
								label={t["media.name"]}
								sortKey="name"
								currentSortBy={sortBy}
								currentSortOrder={sortOrder}
								onSort={onSort}
							/>
							<SortMenuItem
								label={t["media.type"]}
								sortKey="type"
								currentSortBy={sortBy}
								currentSortOrder={sortOrder}
								onSort={onSort}
							/>
							<SortMenuItem
								label={t["media.duration"]}
								sortKey="duration"
								currentSortBy={sortBy}
								currentSortOrder={sortOrder}
								onSort={onSort}
							/>
							<SortMenuItem
								label={t["assets.file_size"]}
								sortKey="size"
								currentSortBy={sortBy}
								currentSortOrder={sortOrder}
								onSort={onSort}
							/>
						</DropdownMenuContent>
					</DropdownMenu>
					<TooltipContent>
						<p>
							{t["media.sort_by_order"]
								.replace("{sortBy}", sortBy)
								.replace(
									"{order}",
									sortOrder === "asc"
										? t["common.ascending"]
										: t["common.descending"],
								)}
						</p>
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
			<Button
				variant="outline"
				onClick={onImport}
				disabled={isProcessing}
				size="sm"
				className="items-center justify-center gap-1.5"
			>
				<HugeiconsIcon icon={CloudUploadIcon} />
				{t["media.upload"]}
			</Button>
		</div>
	);
}

function SortMenuItem({
	label,
	sortKey,
	currentSortBy,
	currentSortOrder,
	onSort,
}: {
	label: string;
	sortKey: MediaSortKey;
	currentSortBy: MediaSortKey;
	currentSortOrder: MediaSortOrder;
	onSort: ({ key }: { key: MediaSortKey }) => void;
}) {
	const isActive = currentSortBy === sortKey;
	const arrow = isActive ? (currentSortOrder === "asc" ? "↑" : "↓") : "";

	return (
		<DropdownMenuItem onClick={() => onSort({ key: sortKey })}>
			{label} {arrow}
		</DropdownMenuItem>
	);
}
