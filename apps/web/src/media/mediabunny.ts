import {
	Input,
	ALL_FORMATS,
	BlobSource,
	VideoSampleSink,
	type VideoCodec,
	type VideoSample,
} from "mediabunny";
import { createTimelineAudioBuffer } from "@/media/audio";
import type { SceneTracks } from "@/timeline";
import type { MediaAsset } from "@/media/types";
import { TICKS_PER_SECOND } from "@/wasm";
import { logger } from "@/services/logging/logger";
import { renderThumbnailDataUrl } from "./thumbnail";

export type VideoFileData = {
	duration: number;
	width: number;
	height: number;
	fps: number;
	hasAudio: boolean;
	codec: VideoCodec | null;
	canDecode: boolean;
	thumbnailUrl: string | null;
};

/**
 * Clamps a seek time into the decodable video span. The span end is the last
 * packet's exact end timestamp — a seek landing on it matches no packet, so
 * the clamp keeps a 1ms epsilon inside the final frame and every request
 * beyond the span holds the last real frame.
 */
function clampToVideoSpan({
	seconds,
	videoSpanSeconds,
}: {
	seconds: number;
	videoSpanSeconds: number;
}): number {
	const bound = Math.max(0, videoSpanSeconds - 0.001);
	return Math.min(Math.max(seconds, 0), bound);
}

export async function readVideoFile({
	file,
}: {
	file: File;
}): Promise<VideoFileData> {
	const input = new Input({
		source: new BlobSource(file),
		formats: ALL_FORMATS,
	});

	try {
		const duration = await input.computeDuration();
		const videoTrack = await input.getPrimaryVideoTrack();

		if (!videoTrack) {
			throw new Error("No video track found in the file");
		}

		const canDecode = await videoTrack.canDecode();
		const packetStats = await videoTrack.computePacketStats(100);
		const audioTrack = await input.getPrimaryAudioTrack();

		let thumbnailUrl: string | null = null;
		if (canDecode) {
			const sink = new VideoSampleSink(videoTrack);
			const frame = await sink.getSample(1);
			if (frame) {
				try {
					thumbnailUrl = renderThumbnailDataUrl({
						width: videoTrack.displayWidth,
						height: videoTrack.displayHeight,
						draw: ({ context, width, height }) => {
							frame.draw(context, 0, 0, width, height);
						},
					});
				} finally {
					frame.close();
				}
			}
		}

		return {
			duration,
			width: videoTrack.displayWidth,
			height: videoTrack.displayHeight,
			fps: packetStats.averagePacketRate,
			hasAudio: audioTrack !== null,
			codec: videoTrack.codec,
			canDecode,
			thumbnailUrl,
		};
	} finally {
		input.dispose();
	}
}

/**
 * Extracts single frames from one video at arbitrary times — the AI
 * image-to-video reference-frame picker. Unlike {@link readVideoFile} this
 * keeps the decoder open, so scrubbing (seek + grab, over and over) does not
 * pay container parsing each time. Call {@link dispose} when done.
 */
export class VideoFrameExtractor {
	private input: Input;
	private sink: VideoSampleSink | null;
	readonly durationSeconds: number;
	private width: number;
	private height: number;
	/**
	 * One canvas reused across every frame we encode. `toDataURL` is
	 * synchronous, so a filmstrip batch is already main-thread work; allocating
	 * (and GC-ing) a fresh canvas per frame made scrubbing noticeably janky.
	 */
	private canvas: HTMLCanvasElement | null = null;

	private constructor(args: {
		input: Input;
		sink: VideoSampleSink | null;
		durationSeconds: number;
		width: number;
		height: number;
	}) {
		this.input = args.input;
		this.sink = args.sink;
		this.durationSeconds = args.durationSeconds;
		this.width = args.width;
		this.height = args.height;
	}

	/** Null when the file has no decodable video track. */
	static async open({
		file,
	}: {
		file: File;
	}): Promise<VideoFrameExtractor | null> {
		const input = new Input({
			source: new BlobSource(file),
			formats: ALL_FORMATS,
		});
		try {
			const track = await input.getPrimaryVideoTrack();
			if (!track) {
				input.dispose();
				return null;
			}
			// The video track's own packet span, not the container max: generated
			// clips routinely carry an audio track (or header duration) that runs
			// past the last video packet, and seeks into that tail return null.
			const duration = await track.computeDuration();
			const sink = (await track.canDecode())
				? new VideoSampleSink(track)
				: null;
			return new VideoFrameExtractor({
				input,
				sink,
				durationSeconds: duration,
				width: track.displayWidth,
				height: track.displayHeight,
			});
		} catch (error) {
			input.dispose();
			throw error;
		}
	}

	/** JPEG dataURL of the frame at `seconds`, long edge capped at `maxEdge`. */
	async frameAt({
		seconds,
		maxEdge = 1920,
	}: {
		seconds: number;
		maxEdge?: number;
	}): Promise<string | null> {
		if (!this.sink) {
			return null;
		}
		const time = clampToVideoSpan({
			seconds,
			videoSpanSeconds: this.durationSeconds,
		});
		// Perf instrumentation (NEXT_PUBLIC_DEBUG_FRAMES=1): scrubbing jank
		// came from here, and the split decode/encode is what tells a slow
		// seek apart from a slow JPEG encode.
		const decodeStarted = performance.now();
		const frame = await this.sink.getSample(time);
		const decodeMs = Math.round(performance.now() - decodeStarted);
		if (!frame) {
			logger.debug("frames.extract miss", {
				seconds: time,
				decode_ms: decodeMs,
			});
			return null;
		}
		try {
			const encodeStarted = performance.now();
			const dataUrl = await this.renderSampleToDataUrl({ frame, maxEdge });
			logger.debug("frames.extract", {
				seconds: time,
				max_edge: maxEdge,
				decode_ms: decodeMs,
				encode_ms: Math.round(performance.now() - encodeStarted),
				bytes: dataUrl?.length ?? 0,
			});
			return dataUrl;
		} finally {
			frame.close();
		}
	}

	/**
	 * JPEG dataURLs for a batch of timestamps in one sorted pass —
	 * samplesAtTimestamps decodes each packet at most once when the
	 * timestamps ascend, so a filmstrip batch costs far less than N separate
	 * getSample calls. Reports each frame through `onFrame` (indexed like
	 * the input array) as it lands; aborts early once `shouldContinue`
	 * returns false. Every yielded sample is closed here.
	 */
	async framesAt({
		seconds,
		maxEdge = 160,
		onFrame,
		shouldContinue,
	}: {
		seconds: number[];
		maxEdge?: number;
		onFrame?: (position: number, dataUrl: string | null) => void;
		shouldContinue?: () => boolean;
	}): Promise<void> {
		if (!this.sink || seconds.length === 0) {
			return;
		}
		const batchStarted = performance.now();
		const order = seconds
			.map((value, index) => ({
				index,
				time: clampToVideoSpan({
					seconds: value,
					videoSpanSeconds: this.durationSeconds,
				}),
			}))
			.sort((left, right) => left.time - right.time);
		let position = 0;
		for await (const frame of this.sink.samplesAtTimestamps(
			order.map((entry) => entry.time),
		)) {
			if (shouldContinue && !shouldContinue()) {
				// The frame for this iteration was already yielded to us —
				// close it before abandoning the batch or it leaks.
				frame?.close();
				break;
			}
			const entry = order[position];
			if (frame) {
				try {
					const dataUrl = await this.renderSampleToDataUrl({
						frame,
						maxEdge,
					});
					if (shouldContinue && !shouldContinue()) break;
					onFrame?.(entry ? entry.index : position, dataUrl);
				} finally {
					frame.close();
				}
			} else {
				onFrame?.(entry ? entry.index : position, null);
			}
			position += 1;
		}
		logger.debug("frames.batch", {
			requested: seconds.length,
			decoded: position,
			total_ms: Math.round(performance.now() - batchStarted),
		});
	}

	/**
	 * Draws one decoded sample onto the shared canvas and encodes it as JPEG.
	 *
	 * Encoding goes through `toBlob` + FileReader rather than `toDataURL`:
	 * the latter is synchronous and blocks the main thread for tens of
	 * milliseconds per frame, which is exactly what made scrubbing stutter.
	 * Both steps here hand the heavy work to the browser and only leave a draw
	 * call on the main thread. Callers await before drawing the next frame, so
	 * reusing one canvas is safe.
	 */
	private async renderSampleToDataUrl({
		frame,
		maxEdge,
	}: {
		frame: VideoSample;
		maxEdge: number;
	}): Promise<string | null> {
		const scale = Math.min(1, maxEdge / Math.max(this.width, this.height));
		const width = Math.max(1, Math.round(this.width * scale));
		const height = Math.max(1, Math.round(this.height * scale));
		const canvas = (this.canvas ??= document.createElement("canvas"));
		if (canvas.width !== width) canvas.width = width;
		if (canvas.height !== height) canvas.height = height;
		const context = canvas.getContext("2d");
		if (!context) {
			return null;
		}
		frame.draw(context, 0, 0, width, height);

		const blob = await new Promise<Blob | null>((resolve) => {
			canvas.toBlob((result) => resolve(result), "image/jpeg", 0.85);
		});
		if (!blob) {
			return null;
		}
		return await new Promise<string | null>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () =>
				resolve(typeof reader.result === "string" ? reader.result : null);
			reader.onerror = () => reject(reader.error);
			reader.readAsDataURL(blob);
		});
	}

	dispose(): void {
		this.input.dispose();
	}
}

const SAMPLE_RATE = 44100;
const NUM_CHANNELS = 2;
const EMPTY_TIMELINE_SILENT_DURATION_SECONDS = 0.1;
const MIN_SILENT_DURATION_SECONDS = 0.001;

export const extractTimelineAudio = async ({
	tracks,
	mediaAssets,
	totalDuration,
	onProgress,
	/**
	 * Output format. Defaults to the 44.1kHz stereo export format; callers
	 * that only analyse audio (transcription) pass 16kHz mono to cut peak
	 * memory ~5.5× on long timelines.
	 */
	sampleRate: targetSampleRate = SAMPLE_RATE,
	channels: targetChannels = NUM_CHANNELS,
	onElementProgress,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	totalDuration: number;
	onProgress?: (progress: number) => void;
	sampleRate?: number;
	channels?: number;
	onElementProgress?: (completed: number, total: number) => void;
}): Promise<Blob> => {
	const samples = await extractTimelineAudioSamples({
		tracks,
		mediaAssets,
		totalDuration,
		onProgress,
		sampleRate: targetSampleRate,
		channels: targetChannels,
		onElementProgress,
	});

	return createWavBlob({
		samples: samples.samples,
		sampleRate: samples.sampleRate,
		channels: targetChannels,
	});
};

/**
 * 与 extractTimelineAudio 相同的提取逻辑，但直接返回单声道/交织浮点 samples，
 * 跳过「编码 int16 WAV → blob → decodeAudioData 解码」的往返。长内容下该
 * 往返意味着多份全量拷贝（blob/arrayBuffer/解码 AudioBuffer/mixdown），
 * decodeAudioData 还是个无进度的黑盒——是「准备音频中」假死的元凶。
 */
export const extractTimelineAudioSamples = async ({
	tracks,
	mediaAssets,
	totalDuration,
	onProgress,
	sampleRate: targetSampleRate = SAMPLE_RATE,
	channels: targetChannels = NUM_CHANNELS,
	onElementProgress,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	totalDuration: number;
	onProgress?: (progress: number) => void;
	sampleRate?: number;
	channels?: number;
	onElementProgress?: (completed: number, total: number) => void;
}): Promise<{ samples: Float32Array; sampleRate: number }> => {
	if (totalDuration === 0) {
		return {
			samples: new Float32Array(
				targetSampleRate * EMPTY_TIMELINE_SILENT_DURATION_SECONDS *
					targetChannels,
			),
			sampleRate: targetSampleRate,
		};
	}

	onProgress?.(10);

	const audioBuffer = await createTimelineAudioBuffer({
		tracks,
		mediaAssets,
		duration: totalDuration,
		sampleRate: targetSampleRate,
		channels: targetChannels,
		onElementProgress,
	});

	if (!audioBuffer) {
		const silentDurationSeconds = Math.max(
			MIN_SILENT_DURATION_SECONDS,
			totalDuration / TICKS_PER_SECOND,
		);
		const silentSamples = new Float32Array(
			Math.ceil(silentDurationSeconds * targetSampleRate) * targetChannels,
		);
		return { samples: silentSamples, sampleRate: targetSampleRate };
	}

	onProgress?.(90);

	const interleavedSamples = interleaveAudioBuffer({
		audioBuffer,
		channels: targetChannels,
	});
	onProgress?.(100);

	return { samples: interleavedSamples, sampleRate: targetSampleRate };
};

function interleaveAudioBuffer({
	audioBuffer,
	channels,
}: {
	audioBuffer: AudioBuffer;
	channels: number;
}): Float32Array {
	const numChannels = Math.min(channels, audioBuffer.numberOfChannels);
	const interleavedSamples = new Float32Array(
		audioBuffer.length * channels,
	);

	for (let sampleIndex = 0; sampleIndex < audioBuffer.length; sampleIndex++) {
		for (let channel = 0; channel < channels; channel++) {
			const sourceChannel = Math.min(channel, Math.max(0, numChannels - 1));
			interleavedSamples[sampleIndex * channels + channel] =
				audioBuffer.getChannelData(sourceChannel)[sampleIndex] ?? 0;
		}
	}

	return interleavedSamples;
}

function createWavBlob({
	samples,
	sampleRate,
	channels,
}: {
	samples: Float32Array;
	sampleRate: number;
	channels: number;
}): Blob {
	const numChannels = channels;
	const bitsPerSample = 16;
	const bytesPerSample = bitsPerSample / 8;
	const numSamples = samples.length / numChannels;
	const dataSize = numSamples * numChannels * bytesPerSample;
	const buffer = new ArrayBuffer(44 + dataSize);
	const view = new DataView(buffer);

	// riff header
	writeString({ view, offset: 0, str: "RIFF" });
	view.setUint32(4, 36 + dataSize, true);
	writeString({ view, offset: 8, str: "WAVE" });

	// fmt chunk
	writeString({ view, offset: 12, str: "fmt " });
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true);
	view.setUint16(22, numChannels, true);
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
	view.setUint16(32, numChannels * bytesPerSample, true);
	view.setUint16(34, bitsPerSample, true);

	// data chunk
	writeString({ view, offset: 36, str: "data" });
	view.setUint32(40, dataSize, true);

	// convert float32 to int16 and write
	let offset = 44;
	for (let i = 0; i < samples.length; i++) {
		const sample = Math.max(-1, Math.min(1, samples[i]));
		const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
		view.setInt16(offset, int16, true);
		offset += 2;
	}

	return new Blob([buffer], { type: "audio/wav" });
}

function writeString({
	view,
	offset,
	str,
}: {
	view: DataView;
	offset: number;
	str: string;
}): void {
	for (let i = 0; i < str.length; i++) {
		view.setUint8(offset + i, str.charCodeAt(i));
	}
}
