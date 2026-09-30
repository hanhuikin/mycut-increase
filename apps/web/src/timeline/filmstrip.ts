"use client";

import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type RefObject,
} from "react";
import { VideoFrameExtractor } from "@/media/mediabunny";
import { TICKS_PER_SECOND, type MediaTime } from "@/wasm";

/** Long-edge cap for filmstrip thumbnails (tiles are ~100px wide). */
const FILMSTRIP_MAX_EDGE = 160;
/** Hard cap on frames decoded per element per regeneration. */
const FILMSTRIP_MAX_SLOTS = 48;
/** Extra slots decoded beyond the visible range on each side. */
const FILMSTRIP_SLOT_BUFFER = 8;
/** LRU cap for the frame cache, keyed by media id + media time. */
const FILMSTRIP_CACHE_LIMIT = 600;

/**
 * Frame cache, keyed `${mediaId}@${mediaTimeTicks}` — LRU via Map insertion
 * order. Survives scrolls, zooms, element moves and remounts; only the
 * slot grid (zoom) decides which keys are wanted.
 */
const frameCache = new Map<string, string>();

function cacheKey({
	mediaId,
	timeTicks,
}: {
	mediaId: string;
	timeTicks: number;
}): string {
	return `${mediaId}@${timeTicks}`;
}

function cacheSet({
	key,
	value,
}: {
	key: string;
	value: string;
}): void {
	frameCache.set(key, value);
	while (frameCache.size > FILMSTRIP_CACHE_LIMIT) {
		const oldest = frameCache.keys().next();
		if (oldest.done) break;
		frameCache.delete(oldest.value);
	}
}

/**
 * Extractor pool, refcounted per media id — one open decoder per source
 * video, shared by every clip using it. Batches run through the global
 * queue below, so the pool never holds more decoders than there are
 * distinct videos with filmstrips on screen.
 */
const pool = new Map<
	string,
	{ extractor: VideoFrameExtractor; refCount: number }
>();
const pendingOpens = new Map<string, Promise<VideoFrameExtractor | null>>();

function acquireExtractor({
	mediaId,
	file,
}: {
	mediaId: string;
	file: File;
}): Promise<VideoFrameExtractor | null> {
	const existing = pool.get(mediaId);
	if (existing) {
		existing.refCount += 1;
		return Promise.resolve(existing.extractor);
	}
	let opening = pendingOpens.get(mediaId);
	if (!opening) {
		opening = VideoFrameExtractor.open({ file })
			.then((extractor) => {
				if (!extractor) return null;
				pool.set(mediaId, { extractor, refCount: 0 });
				return extractor;
			})
			.finally(() => {
				pendingOpens.delete(mediaId);
			});
		pendingOpens.set(mediaId, opening);
	}
	return opening.then((extractor) => {
		if (!extractor) return null;
		const entry = pool.get(mediaId);
		if (!entry) return null;
		entry.refCount += 1;
		return entry.extractor;
	});
}

function releaseExtractor(mediaId: string): void {
	const entry = pool.get(mediaId);
	if (!entry) return;
	entry.refCount -= 1;
	if (entry.refCount <= 0) {
		pool.delete(mediaId);
		pendingOpens.delete(mediaId);
		entry.extractor.dispose();
	}
}

/**
 * Global decode queue — filmstrip batches from every clip run serially so
 * a wide timeline cannot fire dozens of concurrent decodes at the preview
 * renderer's expense.
 */
let queueChain: Promise<void> = Promise.resolve();

function enqueueFilmstripTask({
	task,
}: {
	task: () => Promise<void>;
}): Promise<void> {
	const run = queueChain.then(task, task);
	queueChain = run.then(
		() => {},
		() => {},
	);
	return run;
}

interface FilmstripWindow {
	firstSlot: number;
	lastSlot: number;
	slotSeconds: number;
}

function getFilmstripWindow({
	durationTicks,
	pixelsPerSecond,
	slotWidthPx,
	visiblePx,
}: {
	durationTicks: MediaTime;
	pixelsPerSecond: number;
	slotWidthPx: number;
	visiblePx: { start: number; end: number } | null;
}): FilmstripWindow | null {
	if (pixelsPerSecond <= 0 || slotWidthPx <= 0) return null;
	const slotSeconds = slotWidthPx / pixelsPerSecond;
	if (slotSeconds <= 0) return null;
	const durationSeconds = Number(durationTicks) / TICKS_PER_SECOND;
	const totalSlots = Math.ceil(durationSeconds / slotSeconds);
	if (totalSlots <= 0) return null;
	if (!visiblePx) return null;
	const firstSlot = Math.max(
		0,
		Math.floor(visiblePx.start / slotWidthPx) - FILMSTRIP_SLOT_BUFFER,
	);
	const lastSlot = Math.min(
		totalSlots - 1,
		Math.ceil(visiblePx.end / slotWidthPx) + FILMSTRIP_SLOT_BUFFER,
	);
	if (lastSlot < firstSlot) return null;
	return { firstSlot, lastSlot, slotSeconds };
}

export interface FilmstripArgs {
	mediaId: string;
	file: File | undefined;
	/** Element duration and trim offset, in ticks. */
	durationTicks: MediaTime;
	trimStartTicks: MediaTime;
	rate: number;
	/** Horizontal pixels per timeline second (zoom-dependent). */
	pixelsPerSecond: number;
	/** Width of one filmstrip tile in px (drives the slot grid). */
	slotWidthPx: number;
	/** The layer the visibility observer watches; owned by the caller. */
	containerRef: RefObject<HTMLDivElement | null>;
}

/**
 * Decodes real frames for a clip's visible span, windowed to whatever part
 * of the element intersects the timeline viewport. Returns a slot map
 * (slot index → JPEG dataURL) ready to render edge to edge.
 */
export function useElementFilmstrip({
	mediaId,
	file,
	durationTicks,
	trimStartTicks,
	rate,
	pixelsPerSecond,
	slotWidthPx,
	containerRef,
}: FilmstripArgs): Map<number, string> {
	const [slots, setSlots] = useState<Map<number, string>>(new Map());
	const generationRef = useRef(0);
	/** Frame keys already enqueued (or known-cached) — dedupes batches. */
	const handledKeysRef = useRef<Set<string>>(new Set());
	const [visiblePx, setVisiblePx] = useState<{
		start: number;
		end: number;
	} | null>(null);

	// Track the visible portion of this element inside the timeline
	// viewport. Reacting to IntersectionObserver (root = the scroll
	// container) keeps regenerations to scroll/zoom/resize moments only.
	useEffect(() => {
		const node = containerRef.current;
		if (!node) return;
		const viewport = node.closest("[data-timeline-viewport]");
		const observer = new IntersectionObserver(
			(entries) => {
				const entry = entries[0];
				if (!entry) return;
				const bounds = entry.boundingClientRect;
				const intersect = entry.intersectionRect;
				if (intersect.width <= 0) {
					setVisiblePx(null);
					return;
				}
				setVisiblePx({
					start: Math.max(0, intersect.left - bounds.left),
					end: intersect.left - bounds.left + intersect.width,
				});
			},
			{
				root: viewport instanceof Element ? viewport : null,
				rootMargin: "0px 100px 0px 100px",
			},
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [containerRef]);

	// Hold one pooled decoder for this element for its mounted lifetime.
	const [extractorReady, setExtractorReady] = useState(false);
	useEffect(() => {
		if (!file) return;
		let cancelled = false;
		let acquired = false;
		void acquireExtractor({ mediaId, file }).then((extractor) => {
			if (!extractor) return;
			if (cancelled) {
				releaseExtractor(mediaId);
				return;
			}
			acquired = true;
			setExtractorReady(true);
		});
		return () => {
			cancelled = true;
			if (acquired) releaseExtractor(mediaId);
		};
	}, [mediaId, file]);

	const enabled =
		!!file && extractorReady && pixelsPerSecond > 0 && slotWidthPx > 0;
	const filmstripWindow = useMemo(
		() =>
			getFilmstripWindow({
				durationTicks,
				pixelsPerSecond,
				slotWidthPx,
				visiblePx,
			}),
		[durationTicks, pixelsPerSecond, slotWidthPx, visiblePx],
	);

	// Decode the wanted slot window whenever visibility, zoom or trim
	// changes. Cache hits resolve during render; only misses are decoded,
	// serially through the global queue.
	useEffect(() => {
		if (!enabled || !filmstripWindow) return;
		const generation = ++generationRef.current;
		const misses: Array<{ slot: number; seconds: number; key: string }> =
			[];
		for (
			let slot = filmstripWindow.firstSlot;
			slot <= filmstripWindow.lastSlot && misses.length < FILMSTRIP_MAX_SLOTS;
			slot += 1
		) {
			const localTicks = Math.round(
				(slot + 0.5) * filmstripWindow.slotSeconds * TICKS_PER_SECOND,
			);
			const mediaTicks = Math.round(
				Number(trimStartTicks) + localTicks * rate,
			);
			const key = cacheKey({ mediaId, timeTicks: mediaTicks });
			if (frameCache.has(key) || handledKeysRef.current.has(key)) {
				continue;
			}
			handledKeysRef.current.add(key);
			misses.push({
				slot,
				seconds: mediaTicks / TICKS_PER_SECOND,
				key,
			});
		}
		if (misses.length === 0) return;

		enqueueFilmstripTask({
			task: async () => {
				if (generationRef.current !== generation) return;
				const entry = pool.get(mediaId);
				if (!entry) return;
				// Drop decoded slots that fell far out of the window — the
				// LRU frame cache still holds them for quick returns.
				setSlots((prev) => {
					const next = new Map<number, string>();
					for (const [slot, url] of prev) {
						if (
							slot >= filmstripWindow.firstSlot - 8 &&
							slot <= filmstripWindow.lastSlot + 8
						) {
							next.set(slot, url);
						}
					}
					return next.size === prev.size ? prev : next;
				});
				await entry.extractor.framesAt({
					seconds: misses.map((miss) => miss.seconds),
					maxEdge: FILMSTRIP_MAX_EDGE,
					shouldContinue: () =>
						generationRef.current === generation,
					onFrame: (position, dataUrl) => {
						const miss = misses[position];
						if (!dataUrl || !miss) return;
						cacheSet({ key: miss.key, value: dataUrl });
						setSlots((prev) => {
							const next = new Map(prev);
							next.set(miss.slot, dataUrl);
							return next;
						});
					},
				});
			},
		});
	}, [enabled, filmstripWindow, mediaId, trimStartTicks, rate]);

	// Cache hits resolve during render: state slots first, then the module
	// cache, windowed to the visible slot range.
	const visibleSlots = useMemo(() => {
		const result = new Map<number, string>();
		if (!filmstripWindow) return result;
		for (
			let slot = filmstripWindow.firstSlot;
			slot <= filmstripWindow.lastSlot && result.size < FILMSTRIP_MAX_SLOTS;
			slot += 1
		) {
			const localTicks = Math.round(
				(slot + 0.5) * filmstripWindow.slotSeconds * TICKS_PER_SECOND,
			);
			const key = cacheKey({
				mediaId,
				timeTicks: Math.round(Number(trimStartTicks) + localTicks * rate),
			});
			const decoded = slots.get(slot) ?? frameCache.get(key);
			if (decoded !== undefined) {
				result.set(slot, decoded);
			}
		}
		return result;
	}, [filmstripWindow, slots, mediaId, trimStartTicks, rate]);

	return visibleSlots;
}
