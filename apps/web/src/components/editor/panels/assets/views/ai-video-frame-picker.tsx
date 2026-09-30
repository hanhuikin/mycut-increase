"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { VideoFrameExtractor } from "@/media/mediabunny";
import type { MediaAsset } from "@/media/types";
import { useLocale } from "@/locale/locale-context";
import {
	FramePickerStrip,
	STRIP_MAX_SLOTS,
	STRIP_THUMB_MAX_EDGE,
	type FrameStripWindow,
} from "./frame-picker-strip";

const formatClock = ({ seconds }: { seconds: number }): string => {
	const total = Math.max(0, seconds);
	const minutes = Math.floor(total / 60);
	const secondsPart = Math.floor(total % 60);
	const tenth = Math.floor((total % 1) * 10);
	return `${String(minutes).padStart(2, "0")}:${String(secondsPart).padStart(2, "0")}.${tenth}`;
};

/**
 * The P1 frame picker: scrub one video asset and confirm any frame as an
 * image-to-video reference. The decoder stays open for the dialog's lifetime
 * (see VideoFrameExtractor); the body only mounts while open, so every open
 * starts clean at t=0 with a fresh filmstrip.
 */
export function AiVideoFramePickerDialog({
	asset,
	open,
	onClose,
	onConfirm,
}: {
	asset: MediaAsset;
	open: boolean;
	onClose: () => void;
	onConfirm: (args: { dataUrl: string; timeLabel: string }) => void;
}) {
	const { t } = useLocale();

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<DialogContent className="flex max-h-[85vh] max-w-4xl flex-col">
				<DialogHeader>
					<DialogTitle>
						{t["ai_video.frame_title"]} · {asset.name}
					</DialogTitle>
				</DialogHeader>
				{open && (
					<FramePickerBody
						asset={asset}
						onClose={onClose}
						onConfirm={onConfirm}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function FramePickerBody({
	asset,
	onClose,
	onConfirm,
}: {
	asset: MediaAsset;
	onClose: () => void;
	onConfirm: (args: { dataUrl: string; timeLabel: string }) => void;
}) {
	const { t } = useLocale();
	const extractorRef = useRef<VideoFrameExtractor | null>(null);
	const stripGenerationRef = useRef(0);
	const [duration, setDuration] = useState(0);
	const [currentTime, setCurrentTime] = useState(0);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [slots, setSlots] = useState<Map<number, string>>(new Map());
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);
	const [stripWindow, setStripWindow] = useState<FrameStripWindow | null>(
		null,
	);

	const fps = asset.fps && asset.fps > 0 ? asset.fps : 30;

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const extractor = await VideoFrameExtractor.open({
					file: asset.file,
				});
				if (cancelled) {
					extractor?.dispose();
					return;
				}
				if (!extractor) {
					setFailed(true);
					return;
				}
				extractorRef.current = extractor;
				setDuration(extractor.durationSeconds);
				const first = await extractor.frameAt({ seconds: 0 });
				if (cancelled) {
					extractor.dispose();
					return;
				}
				if (first) setPreviewUrl(first);
			} catch {
				if (!cancelled) setFailed(true);
			}
		})();
		return () => {
			cancelled = true;
			stripGenerationRef.current += 1;
			extractorRef.current?.dispose();
			extractorRef.current = null;
		};
	}, [asset]);

	useEffect(() => {
		const extractor = extractorRef.current;
		if (!extractor) return;
		let cancelled = false;
		// Debounced seek: dragging fires continuously; only the settled value
		// gets decoded.
		const timer = setTimeout(() => {
			void (async () => {
				const frame = await extractor.frameAt({ seconds: currentTime });
				if (cancelled) return;
				if (frame) setPreviewUrl(frame);
				setBusy(false);
			})();
		}, 300);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [currentTime]);

	// Filmstrip generation: the strip reports its visible slot window; decode
	// it in one batch, debounced so drags, flings and zoom bursts settle
	// first. Bumping stripGenerationRef kills in-flight batches.
	const { firstSlot = 0, lastSlot = -1, slotSeconds = 0 } = stripWindow ?? {};

	useEffect(() => {
		const extractor = extractorRef.current;
		if (!extractor || slotSeconds <= 0 || lastSlot < firstSlot) return;
		const generation = ++stripGenerationRef.current;
		const timer = setTimeout(() => {
			void (async () => {
				const indices: number[] = [];
				const times: number[] = [];
				for (
					let index = firstSlot;
					index <= lastSlot && indices.length < STRIP_MAX_SLOTS;
					index += 1
				) {
					indices.push(index);
					times.push((index + 0.5) * slotSeconds);
				}
				// Prune entries far outside the window so the map stays small.
				setSlots((prev) => {
					const next = new Map<number, string>();
					for (const [index, url] of prev) {
						if (index >= firstSlot - 40 && index <= lastSlot + 40) {
							next.set(index, url);
						}
					}
					return next;
				});
				await extractor.framesAt({
					seconds: times,
					maxEdge: STRIP_THUMB_MAX_EDGE,
					shouldContinue: () =>
						stripGenerationRef.current === generation,
					onFrame: (position, dataUrl) => {
						const index = indices[position];
						if (!dataUrl || index === undefined) return;
						if (stripGenerationRef.current !== generation) return;
						setSlots((prev) => {
							const next = new Map(prev);
							next.set(index, dataUrl);
							return next;
						});
					},
				});
			})();
		}, 150);
		return () => clearTimeout(timer);
	}, [firstSlot, lastSlot, slotSeconds]);

	const handleWindowChange = useCallback((next: FrameStripWindow) => {
		setStripWindow((prev) =>
			prev &&
			prev.firstSlot === next.firstSlot &&
			prev.lastSlot === next.lastSlot &&
			prev.slotSeconds === next.slotSeconds
				? prev
				: next,
		);
	}, []);

	// Seek snaps to the frame grid so the time label always matches the
	// decoded frame.
	const seek = (seconds: number) => {
		setBusy(true);
		const snapped = Math.round(seconds * fps) / fps;
		setCurrentTime(Math.min(Math.max(snapped, 0), duration || 0));
	};

	const confirm = () => {
		if (!previewUrl) return;
		onConfirm({
			dataUrl: previewUrl,
			timeLabel: formatClock({ seconds: currentTime }),
		});
	};

	return (
		<>
			{failed ? (
				<div className="text-muted-foreground rounded-md border border-dashed py-10 text-center text-[13px]">
					{t["ai_video.frame_failed"]}
				</div>
			) : (
				<DialogBody className="min-h-0 flex-1 gap-3 overflow-hidden">
					<div className="bg-secondary relative aspect-video max-h-full min-h-0 w-full shrink overflow-hidden rounded-md">
						{previewUrl && (
							// eslint-disable-next-line @next/next/no-img-element
							<img
								src={previewUrl}
								alt={asset.name}
								className="size-full object-contain"
							/>
						)}
						<div className="absolute top-3 left-3 rounded bg-black/60 px-2 py-1 font-mono text-[11.5px] tabular-nums text-white">
							{formatClock({ seconds: currentTime })} /{" "}
							{formatClock({ seconds: duration })}
						</div>
					</div>
					<FramePickerStrip
						duration={duration}
						currentTime={currentTime}
						fps={fps}
						slots={slots}
						disabled={duration <= 0}
						onSeek={seek}
						onWindowChange={handleWindowChange}
					/>
					<p className="text-muted-foreground text-[11.5px]">
						{t["ai_video.frame_hint"]}
					</p>
				</DialogBody>
			)}

			<DialogFooter>
				<Button variant="outline" size="sm" onClick={onClose}>
					{t["common.cancel"]}
				</Button>
				<Button
					size="sm"
					disabled={failed || !previewUrl || busy}
					onClick={confirm}
				>
					{t["ai_video.frame_confirm"]}
				</Button>
			</DialogFooter>
		</>
	);
}

