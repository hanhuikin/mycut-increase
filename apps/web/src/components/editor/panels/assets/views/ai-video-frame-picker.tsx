"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { VideoFrameExtractor } from "@/media/mediabunny";
import type { MediaAsset } from "@/media/types";
import { useLocale } from "@/locale/locale-context";

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
			<DialogContent className="max-w-xl">
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
	const [duration, setDuration] = useState(0);
	const [currentTime, setCurrentTime] = useState(0);
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	const [strip, setStrip] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const extractor = await VideoFrameExtractor.open({ file: asset.file });
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
				const stamps = [0.1, 0.3, 0.5, 0.7, 0.9].map(
					(fraction) => extractor.durationSeconds * fraction,
				);
				const frames = await Promise.all(
					stamps.map((seconds) => extractor.frameAt({ seconds })),
				);
				if (cancelled) {
					extractor.dispose();
					return;
				}
				setStrip(frames.map((frame) => frame ?? ""));
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
			extractorRef.current?.dispose();
			extractorRef.current = null;
		};
	}, [asset]);

	useEffect(() => {
		const extractor = extractorRef.current;
		if (!extractor) return;
		let cancelled = false;
		// Debounced seek: the slider fires continuously; only the settled value
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

	const seek = ({ seconds }: { seconds: number }) => {
		setBusy(true);
		setCurrentTime(Math.min(Math.max(seconds, 0), duration || 0));
	};

	const confirm = () => {
		if (!previewUrl) return;
		onConfirm({ dataUrl: previewUrl, timeLabel: formatClock({ seconds: currentTime }) });
	};

	return (
		<>
			{failed ? (
				<div className="text-muted-foreground rounded-md border border-dashed py-10 text-center text-[13px]">
					{t["ai_video.frame_failed"]}
				</div>
			) : (
				<>
					<div className="bg-secondary relative aspect-video overflow-hidden rounded-md">
						{previewUrl && (
							// eslint-disable-next-line @next/next/no-img-element
							<img
								src={previewUrl}
								alt={asset.name}
								className={`size-full object-contain transition-opacity ${busy ? "opacity-60" : ""}`}
							/>
						)}
					</div>
					<div className="text-muted-foreground mt-1 font-mono text-[11.5px]">
						{formatClock({ seconds: currentTime })} /{" "}
						{formatClock({ seconds: duration })}
					</div>

					<input
						type="range"
						min={0}
						max={duration || 0}
						step={0.1}
						value={currentTime}
						disabled={failed || duration === 0}
						onChange={(event) => seek({ seconds: Number(event.target.value) })}
						className="mt-1 w-full cursor-pointer accent-[var(--primary)]"
					/>

					{strip.length > 0 && (
						<div className="mt-1 flex gap-1">
							{strip.map((frame, index) =>
								frame ? (
									<button
										key={index}
										type="button"
										onClick={() =>
											seek({
												seconds: ((index + 0.5) / strip.length) * duration,
											})
										}
										className="focus-visible:ring-primary/60 overflow-hidden rounded outline-none focus-visible:ring-2"
									>
										{/* eslint-disable-next-line @next/next/no-img-element */}
										<img
											src={frame}
											alt=""
											className="h-9 w-full min-w-0 object-cover"
										/>
									</button>
								) : (
									<div key={index} className="bg-secondary h-9 flex-1 rounded" />
								),
							)}
						</div>
					)}

					<p className="text-muted-foreground mt-1 text-[11.5px]">
						{t["ai_video.frame_hint"]}
					</p>
				</>
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
