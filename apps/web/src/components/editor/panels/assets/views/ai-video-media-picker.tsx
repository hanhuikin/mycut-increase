"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import type { MediaAsset } from "@/media/types";
import type { LocaleKey } from "@/locale";
import { useLocale } from "@/locale/locale-context";

type PickerFilter = "all" | "video" | "image";
type PickerMode = "single" | "multi";

const FILTERS: Array<{ value: PickerFilter; labelKey: LocaleKey }> = [
	{ value: "all", labelKey: "ai_video.picker_all" },
	{ value: "video", labelKey: "ai_video.picker_videos" },
	{ value: "image", labelKey: "ai_video.picker_images" },
];

const formatDuration = ({ seconds }: { seconds: number }): string => {
	const total = Math.max(0, Math.floor(seconds));
	const minutes = Math.floor(total / 60);
	const rest = total % 60;
	return `${minutes}:${String(rest).padStart(2, "0")}`;
};

/**
 * "Choose from library" dialog for AI reference images.
 *
 * Two modes:
 * - "single" (default): the image-to-video reference frame — one asset back.
 * - "multi": the multi-image-to-image slot filler — up to `max` assets back.
 *
 * Confirming hands the assets back — the parent owns everything after that
 * point, because it also knows which target opened the dialog.
 *
 * Filter/selection state lives in the body component, which only mounts while
 * the dialog is open, so every open starts clean.
 */
export function AiVideoMediaPickerDialog({
	open,
	assets,
	maxImageBytes,
	mode = "single",
	max = 1,
	onClose,
	onConfirm,
	onConfirmMulti,
	onLocalUpload,
}: {
	open: boolean;
	assets: MediaAsset[];
	maxImageBytes: number;
	mode?: PickerMode;
	max?: number;
	onClose: () => void;
	onConfirm: (args: { asset: MediaAsset }) => void;
	onConfirmMulti?: (args: { assets: MediaAsset[] }) => void;
	onLocalUpload: () => void;
}) {
	const { t } = useLocale();

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<DialogContent className="max-w-xl">
				<DialogHeader>
					<DialogTitle>{t["ai_video.picker_title"]}</DialogTitle>
				</DialogHeader>
				{open && (
					<PickerBody
						assets={assets}
						maxImageBytes={maxImageBytes}
						mode={mode}
						max={max}
						onClose={onClose}
						onConfirm={onConfirm}
						onConfirmMulti={onConfirmMulti}
						onLocalUpload={onLocalUpload}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function PickerBody({
	assets,
	maxImageBytes,
	mode,
	max,
	onClose,
	onConfirm,
	onConfirmMulti,
	onLocalUpload,
}: {
	assets: MediaAsset[];
	maxImageBytes: number;
	mode: PickerMode;
	max: number;
	onClose: () => void;
	onConfirm: (args: { asset: MediaAsset }) => void;
	onConfirmMulti?: (args: { assets: MediaAsset[] }) => void;
	onLocalUpload: () => void;
}) {
	const { t } = useLocale();
	const [filter, setFilter] = useState<PickerFilter>("all");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

	const isMulti = mode === "multi";
	const visible = assets.filter(
		(asset) => filter === "all" || asset.type === filter,
	);
	const selected = assets.find((asset) => asset.id === selectedId) ?? null;
	const multiSelected = assets.filter((asset) => selectedIds.has(asset.id));

	const toggleMulti = (asset: MediaAsset) => {
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(asset.id)) {
				next.delete(asset.id);
			} else if (next.size < max) {
				next.add(asset.id);
			}
			return next;
		});
	};

	/** Why this tile cannot be picked, or null when it can. */
	const blockedReason = (asset: MediaAsset): LocaleKey | null => {
		if (asset.type === "video" && !asset.thumbnailUrl) {
			return "ai_video.picker_no_preview";
		}
		if (asset.file.size > maxImageBytes) {
			return "ai_video.picker_too_large";
		}
		return null;
	};

	return (
		<>
			<div className="mb-3 flex gap-1.5">
				{FILTERS.map((entry) => (
					<button
						key={entry.value}
						type="button"
						onClick={() => setFilter(entry.value)}
						className={`border-border text-muted-foreground hover:text-foreground rounded-full border px-3 py-0.5 text-xs transition-colors ${
							filter === entry.value
								? "border-primary text-primary bg-primary/10"
								: ""
						}`}
					>
						{t[entry.labelKey]}
					</button>
				))}
			</div>

			{visible.length === 0 ? (
				<div className="text-muted-foreground flex flex-col items-center gap-3 rounded-md border border-dashed py-10 text-center text-[13px]">
					<span>{t["ai_video.picker_empty"]}</span>
					<Button variant="outline" size="sm" onClick={onLocalUpload}>
						{t["ai_video.picker_local_fallback"]}
					</Button>
				</div>
			) : (
				<div className="grid max-h-[46vh] grid-cols-3 gap-2.5 overflow-y-auto p-0.5 sm:grid-cols-4">
					{visible.map((asset) => {
						const reason = blockedReason(asset);
						const selectable = reason === null;
						const thumb = asset.thumbnailUrl ?? asset.url;
						const isSelected = isMulti
							? selectedIds.has(asset.id)
							: selectedId === asset.id;
						return (
							<button
								key={asset.id}
								type="button"
								disabled={!selectable}
								title={reason ? t[reason] : asset.name}
								aria-pressed={isSelected}
								onClick={() => {
									if (isMulti) {
										toggleMulti(asset);
									} else {
										setSelectedId(asset.id);
									}
								}}
								className={`relative overflow-hidden rounded-md border text-left transition-colors ${
									isSelected
										? "border-primary ring-primary/50 ring-2"
										: "border-border hover:border-primary/60"
								} ${selectable ? "" : "opacity-45"}`}
							>
								<div className="bg-secondary relative aspect-video">
									{thumb ? (
										// eslint-disable-next-line @next/next/no-img-element
										<img
											src={thumb}
											alt={asset.name}
											className="size-full object-cover"
										/>
									) : (
										<div className="text-muted-foreground flex size-full items-center justify-center text-lg">
											🎞️
										</div>
									)}
									{asset.type === "video" && asset.duration != null && (
										<span className="absolute right-1 bottom-1 rounded-sm bg-black/60 px-1 text-[10px] text-white">
											{formatDuration({ seconds: asset.duration })}
										</span>
									)}
									{isSelected && (
										<span className="bg-primary absolute top-1 right-1 flex size-4 items-center justify-center rounded-full text-[10px] text-white">
											✓
										</span>
									)}
								</div>
								<div className="text-muted-foreground truncate px-1.5 py-1 text-[10.5px]">
									{asset.name}
								</div>
							</button>
						);
					})}
				</div>
			)}

			<DialogFooter>
				<span className="text-muted-foreground mr-auto text-[11.5px]">
					{isMulti
						? t["ai_img2img.picker_multi_hint"]
								.replace("{n}", String(multiSelected.length))
								.replace("{max}", String(max))
						: t["ai_video.picker_cover_hint"]}
				</span>
				<Button variant="outline" size="sm" onClick={onClose}>
					{t["common.cancel"]}
				</Button>
				{isMulti ? (
					<Button
						size="sm"
						disabled={multiSelected.length === 0}
						onClick={() => {
							if (multiSelected.length > 0) {
								onConfirmMulti?.({ assets: multiSelected });
							}
						}}
					>
						{t["ai_img2img.picker_multi_confirm"].replace(
							"{n}",
							String(multiSelected.length),
						)}
					</Button>
				) : (
					<Button
						size="sm"
						disabled={!selected}
						onClick={() => {
							if (selected) onConfirm({ asset: selected });
						}}
					>
						{t["ai_video.picker_confirm"]}
					</Button>
				)}
			</DialogFooter>
		</>
	);
}
