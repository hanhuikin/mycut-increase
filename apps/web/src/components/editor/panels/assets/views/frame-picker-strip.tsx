"use client";

import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
	type MouseEvent as ReactMouseEvent,
} from "react";
import { ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { floatToFrameRate } from "@/fps/utils";
import { useContainerSize } from "@/hooks/use-container-size";
import { useLocale } from "@/locale/locale-context";
import { useEdgeAutoScroll } from "@/timeline/hooks/use-edge-auto-scroll";
import {
	formatRulerLabel,
	getRulerConfig,
	shouldShowLabel,
} from "@/timeline/ruler-utils";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/timeline/scale";

/** Width of one filmstrip slot; one decoded frame covers the whole slot. */
export const SLOT_WIDTH_PX = 64;
/** Hard cap on frames decoded per regeneration batch. */
export const STRIP_MAX_SLOTS = 48;
/** Long-edge cap for filmstrip thumbnails (rendered ~48px tall). */
export const STRIP_THUMB_MAX_EDGE = 160;
/** Zoom ceiling: at 500 px/s one 30fps frame is ~17px wide. */
const STRIP_MAX_PX_PER_SECOND = 500;
const ZOOM_BUTTON_FACTOR = 1.6;
const WHEEL_STEP_PX = 53;
const PLAYHEAD_WIDTH_PX = 2;

export interface FrameStripWindow {
	firstSlot: number;
	lastSlot: number;
	slotSeconds: number;
}

interface FramePickerStripProps {
	duration: number;
	currentTime: number;
	fps: number;
	slots: Map<number, string>;
	disabled?: boolean;
	onSeek: (seconds: number) => void;
	onWindowChange: (window: FrameStripWindow) => void;
}

/**
 * A zoomable mini-timeline for the frame picker: a ruler with time/frame
 * labels, a filmstrip of thumbnails, and a playhead styled after the editor
 * timeline's. Owns the view state (zoom as a multiplier over fit-to-width,
 * scroll position) and reports the visible slot window upward so the parent
 * can decode exactly the frames on screen.
 */
export function FramePickerStrip({
	duration,
	currentTime,
	fps,
	slots,
	disabled = false,
	onSeek,
	onWindowChange,
}: FramePickerStripProps) {
	const { t } = useLocale();
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const contentRef = useRef<HTMLDivElement | null>(null);
	const { width } = useContainerSize({ containerRef: scrollRef });
	const [zoom, setZoom] = useState(1);
	const [scrollLeft, setScrollLeft] = useState(0);
	const [isDragging, setIsDragging] = useState(false);
	const pendingScrollLeftRef = useRef<number | null>(null);
	const lastMouseClientXRef = useRef(0);
	const applyZoomRef = useRef<
		(args: {
			factor: number;
			anchorClientX?: number;
			anchorTime?: number;
		}) => void
	>(() => {});

	const ready = width > 0 && duration > 0;
	const fit = ready ? width / duration : 0;
	const pps = fit * zoom;
	const maxZoom = fit > 0 ? Math.max(1, STRIP_MAX_PX_PER_SECOND / fit) : 1;
	const contentWidth = duration * pps;
	const slotSeconds = pps > 0 ? SLOT_WIDTH_PX / pps : 0;

	const frameRate = useMemo(() => floatToFrameRate(fps), [fps]);
	const ruler = useMemo(
		() =>
			getRulerConfig({
				zoomLevel: pps / BASE_TIMELINE_PIXELS_PER_SECOND,
				fps: frameRate,
			}),
		[pps, frameRate],
	);

	// Ticks are window-sliced: only render the viewport ± one screen of
	// buffer, so a 5-minute video at fit zoom never means thousands of nodes.
	const ticks = useMemo(() => {
		if (!ready) return [];
		const viewStart = Math.max(0, scrollLeft - width);
		const viewEnd = scrollLeft + 2 * width;
		const first = Math.max(
			0,
			Math.floor(viewStart / ruler.tickIntervalSeconds),
		);
		const last = Math.floor(viewEnd / ruler.tickIntervalSeconds);
		const result: Array<{ time: number; isLabel: boolean }> = [];
		for (let index = first; index <= last; index += 1) {
			const time = index * ruler.tickIntervalSeconds;
			result.push({
				time,
				isLabel: shouldShowLabel({
					time,
					labelIntervalSeconds: ruler.labelIntervalSeconds,
				}),
			}
			);
		}
		return result;
	}, [ready, scrollLeft, width, ruler]);

	// Same windowing for the filmstrip slots; the parent decodes exactly
	// these (plus buffer) through framesAt.
	const renderSlots = useMemo(() => {
		if (!ready || slotSeconds <= 0) return [];
		const totalSlots = Math.ceil(duration / slotSeconds);
		const first = Math.max(0, Math.floor(scrollLeft / SLOT_WIDTH_PX));
		const last = Math.min(
			totalSlots - 1,
			Math.floor((scrollLeft + width) / SLOT_WIDTH_PX),
		);
		const result: number[] = [];
		for (let index = first; index <= last; index += 1) {
			result.push(index);
		}
		return result;
	}, [ready, scrollLeft, width, duration, slotSeconds]);

	// Report the generation window (viewport ± one screen) upward; the
	// parent dedupes by value and debounces the decode.
	useEffect(() => {
		if (!ready || slotSeconds <= 0) return;
		const totalSlots = Math.ceil(duration / slotSeconds);
		const firstSlot = Math.max(
			0,
			Math.floor((scrollLeft - width) / SLOT_WIDTH_PX),
		);
		const lastSlot = Math.min(
			totalSlots - 1,
			Math.ceil((scrollLeft + 2 * width) / SLOT_WIDTH_PX),
		);
		onWindowChange({ firstSlot, lastSlot, slotSeconds });
	}, [ready, scrollLeft, width, duration, slotSeconds, onWindowChange]);

	// rAF-throttled scroll tracking keeps the tick/slot windows in sync with
	// both user scrolling and the edge auto-scroll's imperative writes.
	useEffect(() => {
		const element = scrollRef.current;
		if (!element || disabled) return;
		let raf: ReturnType<typeof requestAnimationFrame> | null = null;
		const onScroll = () => {
			if (raf !== null) return;
			raf = requestAnimationFrame(() => {
				raf = null;
				setScrollLeft(element.scrollLeft);
			});
		};
		element.addEventListener("scroll", onScroll, { passive: true });
		return () => {
			element.removeEventListener("scroll", onScroll);
			if (raf !== null) cancelAnimationFrame(raf);
		};
	}, [disabled]);

	// Wheel: Ctrl/Cmd+wheel zooms (rAF-batched, same curve as the timeline);
	// plain wheel pans horizontally.
	useEffect(() => {
		const element = scrollRef.current;
		if (!element || disabled) return;
		let pendingZoomDelta = 0;
		let zoomRaf: ReturnType<typeof requestAnimationFrame> | null = null;
		let anchorClientX = 0;
		const onWheel = (event: WheelEvent) => {
			if (event.ctrlKey || event.metaKey) {
				event.preventDefault();
				anchorClientX = event.clientX;
				const normalizedDelta =
					event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
				pendingZoomDelta += normalizedDelta;
				if (zoomRaf === null) {
					zoomRaf = requestAnimationFrame(() => {
						const capped =
							Math.sign(pendingZoomDelta) *
							Math.min(Math.abs(pendingZoomDelta), 30);
						applyZoomRef.current({
							factor: Math.exp(-capped / 300),
							anchorClientX,
						});
						pendingZoomDelta = 0;
						zoomRaf = null;
					});
				}
				return;
			}
			event.preventDefault();
			const raw =
				Math.abs(event.deltaX) > Math.abs(event.deltaY)
					? event.deltaX
					: event.deltaY;
			const clamped =
				Math.sign(raw) * Math.min(Math.abs(raw), WHEEL_STEP_PX);
			element.scrollLeft = Math.max(0, element.scrollLeft + clamped);
		};
		element.addEventListener("wheel", onWheel, { passive: false });
		return () => {
			element.removeEventListener("wheel", onWheel);
			if (zoomRaf !== null) cancelAnimationFrame(zoomRaf);
		};
	}, [disabled]);

	// Keeps the time under the cursor under the cursor while zooming.
	const applyZoom = ({
		factor,
		anchorClientX,
		anchorTime,
	}: {
		factor: number;
		anchorClientX?: number;
		anchorTime?: number;
	}) => {
		const element = scrollRef.current;
		if (!element || !ready || pps <= 0) return;
		const rect = element.getBoundingClientRect();
		const cursorX =
			anchorClientX !== undefined
				? anchorClientX - rect.left
				: (anchorTime ?? 0) * pps - element.scrollLeft;
		const anchor = (element.scrollLeft + cursorX) / pps;
		const nextZoom = Math.min(maxZoom, Math.max(1, zoom * factor));
		if (nextZoom === zoom) return;
		// scrollLeft clamps against the old content width, so the new offset
		// is applied in the layout effect below after the content resizes.
		pendingScrollLeftRef.current = anchor * fit * nextZoom - cursorX;
		setZoom(nextZoom);
	};
	useEffect(() => {
		applyZoomRef.current = applyZoom;
	});

	// Applies the anchored-zoom scroll offset and re-clamps after zoom-outs
	// and resizes shrink the content.
	useLayoutEffect(() => {
		const element = scrollRef.current;
		if (!element) return;
		const maxScroll = Math.max(0, contentWidth - width);
		const target = pendingScrollLeftRef.current ?? element.scrollLeft;
		pendingScrollLeftRef.current = null;
		element.scrollLeft = Math.min(Math.max(target, 0), maxScroll);
	}, [contentWidth, width]);

	const getMouseClientX = useCallback(() => lastMouseClientXRef.current, []);

	useEdgeAutoScroll({
		isActive: isDragging,
		getMouseClientX,
		rulerScrollRef: scrollRef,
		tracksScrollRef: scrollRef,
		contentWidth,
	});

	// Press-and-drag anywhere on the ruler or the filmstrip scrubs; times
	// snap to the frame grid so the label matches the decoded frame.
	const startScrub = (event: ReactMouseEvent) => {
		if (disabled || !ready || pps <= 0 || event.button !== 0) return;
		const content = contentRef.current;
		if (!content) return;
		event.preventDefault();
		lastMouseClientXRef.current = event.clientX;
		setIsDragging(true);
		const seekFromClientX = (clientX: number) => {
			const raw = (clientX - content.getBoundingClientRect().left) / pps;
			onSeek(Math.round(raw * fps) / fps);
		};
		seekFromClientX(event.clientX);
		const onMove = (moveEvent: MouseEvent) => {
			lastMouseClientXRef.current = moveEvent.clientX;
			seekFromClientX(moveEvent.clientX);
		};
		const onUp = () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			setIsDragging(false);
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
	};

	const handleKeyDown = (event: ReactKeyboardEvent) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		const frameSeconds = fps > 0 ? 1 / fps : 1 / 30;
		const direction = event.key === "ArrowRight" ? 1 : -1;
		onSeek(currentTime + direction * frameSeconds);
	};

	const zoomButtonAnchor = () => {
		const element = scrollRef.current;
		if (!element || !ready || pps <= 0) return 0;
		const visibleStart = element.scrollLeft / pps;
		const visibleEnd = (element.scrollLeft + width) / pps;
		return Math.min(Math.max(currentTime, visibleStart), visibleEnd);
	};

	// No early return while loading: the scroll container must exist on first
	// mount so the ResizeObserver attaches (it only fires when the ref is
	// populated at effect time, and effects don't re-run when a ref fills).
	// With duration or width at 0 the rows below simply render empty.

	return (
		<div className="relative">
			<div
				ref={scrollRef}
				className="overflow-x-auto"
				style={{ scrollbarGutter: "stable" }}
			>
				<div
					ref={contentRef}
					className="relative select-none"
					style={{ width: `${Math.max(contentWidth, width)}px` }}
				>
					{/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- spatial scrub surface; keyboard control is on the playhead (role="slider") beside it. */}
					<div
						className="border-border/60 relative h-5 cursor-col-resize border-b"
						onMouseDown={startScrub}
					>
						{ticks.map(({ time, isLabel }) =>
							isLabel ? (
								<span
									key={time}
									className="text-muted-foreground/85 absolute top-1 text-[10px] leading-none select-none"
									style={{ left: `${time * pps + 3}px` }}
								>
									{formatRulerLabel({
										timeInSeconds: time,
										fps: frameRate,
									})}
								</span>
							) : (
								<div
									key={time}
									className="border-muted-foreground/25 absolute top-1.5 h-1.5 border-l"
									style={{ left: `${time * pps}px` }}
								/>
							),
						)}
					</div>
					{/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- spatial scrub surface; keyboard control is on the playhead (role="slider") beside it. */}
					<div
						className="bg-secondary/60 relative mt-0.5 h-12 cursor-col-resize"
						onMouseDown={startScrub}
					>
						{renderSlots.map((index) => {
							const frame = slots.get(index);
							return (
								<div
									key={index}
									className="absolute inset-y-0 p-px"
									style={{
										left: `${index * SLOT_WIDTH_PX}px`,
										width: `${SLOT_WIDTH_PX}px`,
									}}
								>
									{frame ? (
										// eslint-disable-next-line @next/next/no-img-element
										<img
											src={frame}
											alt=""
											draggable={false}
											className="size-full rounded-sm object-cover"
										/>
									) : (
										<div className="bg-secondary size-full animate-pulse rounded-sm" />
									)}
								</div>
							);
						})}
					</div>
					<div
						role="slider"
						aria-label={t["timeline.timeline_playhead"]}
						aria-valuemin={0}
						aria-valuemax={duration}
						aria-valuenow={currentTime}
						tabIndex={0}
						className="pointer-events-none absolute inset-y-0 outline-none"
						style={{
							left: `${currentTime * pps}px`,
							width: `${PLAYHEAD_WIDTH_PX}px`,
						}}
						onKeyDown={handleKeyDown}
					>
						<div className="bg-primary pointer-events-none absolute left-0 h-full w-0.5" />
						<button
							type="button"
							aria-label={t["timeline.drag_playhead"]}
							className={`pointer-events-auto absolute top-1 left-1/2 size-3 -translate-x-1/2 transform cursor-col-resize rounded-full border-2 shadow-xs ${isDragging ? "bg-primary border-primary" : "bg-primary border-primary/50"}`}
							onMouseDown={startScrub}
						/>
					</div>
				</div>
			</div>
			<div className="absolute top-0 right-2 z-10 flex gap-0.5">
				<Button
					variant="ghost"
					size="icon"
					className="size-6"
					aria-label={t["ai_video.frame_zoom_out"]}
					disabled={zoom <= 1}
					onClick={() =>
						applyZoom({
							factor: 1 / ZOOM_BUTTON_FACTOR,
							anchorTime: zoomButtonAnchor(),
						})
					}
				>
					<ZoomOut className="size-3.5" />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					className="size-6"
					aria-label={t["ai_video.frame_zoom_in"]}
					disabled={zoom >= maxZoom}
					onClick={() =>
						applyZoom({
							factor: ZOOM_BUTTON_FACTOR,
							anchorTime: zoomButtonAnchor(),
						})
					}
				>
					<ZoomIn className="size-3.5" />
				</Button>
			</div>
		</div>
	);
}

