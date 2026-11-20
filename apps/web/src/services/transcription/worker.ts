import {
	env,
	pipeline,
	type AutomaticSpeechRecognitionPipeline,
	type AutomaticSpeechRecognitionOutput,
} from "@huggingface/transformers";
import type { TranscriptionSegment } from "@/transcription/types";
import {
	DEFAULT_CHUNK_LENGTH_SECONDS,
	DEFAULT_STRIDE_SECONDS,
} from "@/transcription/audio";

// 模型权重默认从 huggingface.co 下载，国内直连不通（转写初始化直接
// "Failed to fetch"）。改走 hf-mirror 镜像——URL 路径结构与官方完全一致，
// 仅换域名；可用 NEXT_PUBLIC_HF_ENDPOINT 覆盖（自建反代/内网镜像）。
// 不尝试本地 /models 目录（应用里不存在），下载结果由浏览器 Cache Storage 缓存。
env.remoteHost = process.env.NEXT_PUBLIC_HF_ENDPOINT || "https://hf-mirror.com";
env.allowLocalModels = false;

// ONNX Runtime 的 wasm 二进制默认从 cdn.jsdelivr.net 拉（transformers.js 内部
// 硬编码，remoteHost 管不到这条路径），国内对 jsdelivr 间歇性不可达时同样
// "Failed to fetch"。构建期由 scripts/sync-ort-wasm.mjs 把 dist 里的 ort-wasm-*
// 拷进 public/ort/，这里改同源加载；文件带 etag，浏览器 304 校验不会反复重下。
env.backends.onnx.wasm.wasmPaths = "/ort/";

export type WorkerMessage =
	| { type: "init"; modelId: string }
	| {
			type: "transcribe";
			audio: Float32Array;
			language: string;
			sampleRate: number;
	  }
	| { type: "cancel" };

export type WorkerResponse =
	| { type: "init-progress"; progress: number }
	| { type: "init-complete" }
	| { type: "init-error"; error: string }
	| { type: "transcribe-progress"; progress: number }
	| {
			type: "transcribe-complete";
			text: string;
			segments: TranscriptionSegment[];
			language?: string;
	  }
	| { type: "transcribe-error"; error: string }
	| { type: "cancelled" };

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let cancelled = false;
let lastReportedProgress = -1;
const fileBytes = new Map<string, { loaded: number; total: number }>();

	self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
		const message = event.data;

		switch (message.type) {
			case "init":
				await handleInit({ modelId: message.modelId });
				break;
			case "transcribe":
				await handleTranscribe({
					audio: message.audio,
					language: message.language,
					sampleRate: message.sampleRate,
				});
				break;
			case "cancel":
				cancelled = true;
				self.postMessage({ type: "cancelled" } satisfies WorkerResponse);
				break;
		}
	};

// 线程级兜底：未捕获异常（含部分 OOM 场景）走这里，保证主线程的 Promise
// 能收到失败而不是永远 pending。
self.onerror = (event) => {
	const detail =
		typeof event === "string"
			? event
			: ((event as ErrorEvent).message ?? "Transcription worker crashed");
	self.postMessage({
		type: "transcribe-error",
		error: detail || "Transcription worker crashed",
	} satisfies WorkerResponse);
};

async function handleInit({ modelId }: { modelId: string }) {
	lastReportedProgress = -1;
	fileBytes.clear();

	try {
		transcriber = (await pipeline("automatic-speech-recognition", modelId, {
			dtype: "q4",
			device: "auto",
			progress_callback: (progressInfo: {
				status?: string;
				file?: string;
				loaded?: number;
				total?: number;
			}) => {
				const file = progressInfo.file;
				if (!file) return;

				const loaded = progressInfo.loaded ?? 0;
				const total = progressInfo.total ?? 0;

				if (progressInfo.status === "progress" && total > 0) {
					fileBytes.set(file, { loaded, total });
				} else if (progressInfo.status === "done") {
					const existing = fileBytes.get(file);
					if (existing) {
						fileBytes.set(file, {
							loaded: existing.total,
							total: existing.total,
						});
					}
				}

				// sum all bytes
				let totalLoaded = 0;
				let totalSize = 0;
				for (const { loaded, total } of fileBytes.values()) {
					totalLoaded += loaded;
					totalSize += total;
				}

				if (totalSize === 0) return;

				const overallProgress = (totalLoaded / totalSize) * 100;
				const roundedProgress = Math.floor(overallProgress);

				if (roundedProgress !== lastReportedProgress) {
					lastReportedProgress = roundedProgress;
					self.postMessage({
						type: "init-progress",
						progress: roundedProgress,
					} satisfies WorkerResponse);
				}
			},
		})) as unknown as AutomaticSpeechRecognitionPipeline;

		self.postMessage({ type: "init-complete" } satisfies WorkerResponse);
	} catch (error) {
		self.postMessage({
			type: "init-error",
			error: error instanceof Error ? error.message : "Failed to load model",
		} satisfies WorkerResponse);
	}
}

// 分段转写参数。transformers.js 的 _call_whisper 会把所有 30s 窗口的特征
// 张量一次性建好再逐个生成——长音频一次喂入是 GB 级内存，WASM 堆直接 OOM，
// worker 崩掉后 UI 永远停在"转写中"。按 90s 切片逐段调用：每段内部只有
// ~4 个窗口张量，峰值内存 MB 级；段间上报真实进度；单段失败可重试。
const SLICE_SECONDS = 90;
// 相邻切片的重叠秒数：避免在词中间硬切。重叠区两侧都会识别出边界词，
// 合并时按「中点属于哪个切片」去重（见 handleTranscribe）。
const OVERLAP_SECONDS = 2;

async function handleTranscribe({
	audio,
	language,
	sampleRate,
}: {
	audio: Float32Array;
	language: string;
	sampleRate: number;
}) {
	if (!transcriber) {
		self.postMessage({
			type: "transcribe-error",
			error: "Model not initialized",
		} satisfies WorkerResponse);
		return;
	}

	cancelled = false;

	const totalSamples = audio.length;
	const sliceSamples = Math.max(
		1,
		Math.floor(SLICE_SECONDS * sampleRate),
	);
	const overlapSamples = Math.min(
		sliceSamples - 1,
		Math.floor(OVERLAP_SECONDS * sampleRate),
	);

	/** 全部时间戳已换算为相对整段音频的绝对秒。 */
	const segments: TranscriptionSegment[] = [];

	try {
		let sliceStart = 0;
		while (sliceStart < totalSamples) {
			if (cancelled) return;

			const isLastSlice = sliceStart + sliceSamples >= totalSamples;
			// 非末段多喂 overlap 秒，边界词由两侧切片各识别一次
			const sliceEnd = Math.min(
				totalSamples,
				sliceStart + sliceSamples + (isLastSlice ? 0 : overlapSamples),
			);
			const nextSliceStart = Math.min(
				totalSamples,
				sliceStart + sliceSamples - overlapSamples,
			);
			const offsetSeconds = sliceStart / sampleRate;
			const boundarySeconds = nextSliceStart / sampleRate;
			// subarray 是视图，零拷贝
			const slice = audio.subarray(sliceStart, sliceEnd);

			let rawResult:
				| AutomaticSpeechRecognitionOutput
				| AutomaticSpeechRecognitionOutput[];
			try {
				rawResult = await transcriber(slice, {
					chunk_length_s: DEFAULT_CHUNK_LENGTH_SECONDS,
					stride_length_s: DEFAULT_STRIDE_SECONDS,
					language: language === "auto" ? undefined : language,
					return_timestamps: true,
				});
			} catch (error) {
				if (cancelled) return;
				// 单段重试一次：内存紧张/瞬时解码错误多见于段边界
				rawResult = await transcriber(slice, {
					chunk_length_s: DEFAULT_CHUNK_LENGTH_SECONDS,
					stride_length_s: DEFAULT_STRIDE_SECONDS,
					language: language === "auto" ? undefined : language,
					return_timestamps: true,
				});
			}

			if (cancelled) return;

			const result: AutomaticSpeechRecognitionOutput = Array.isArray(rawResult)
				? rawResult[0]
				: rawResult;

			// 重叠区去重：上一段遗留的「中点越过当前切片起点」的段落移除，
			// 当前切片只保留中点落在自己区间内的段落（首段全保留）。
			if (sliceStart > 0) {
				for (let i = segments.length - 1; i >= 0; i--) {
					const previous = segments[i];
					if ((previous.start + previous.end) / 2 >= boundarySeconds) {
						segments.splice(i, 1);
					}
				}
			}

			if (result.chunks) {
				for (const chunk of result.chunks) {
					if (!chunk.timestamp || chunk.timestamp.length < 2) continue;
					const start = offsetSeconds + (chunk.timestamp[0] ?? 0);
					const end = offsetSeconds + (chunk.timestamp[1] ?? chunk.timestamp[0] ?? 0);
					if (sliceStart > 0 && (start + end) / 2 < boundarySeconds) {
						// 属于上一切片的辖区
						continue;
					}
					segments.push({ text: chunk.text, start, end });
				}
			}

			const processedSamples = Math.min(
				totalSamples,
				sliceStart + sliceSamples,
			);
			self.postMessage({
				type: "transcribe-progress",
				progress: Math.min(100, (processedSamples / totalSamples) * 100),
			} satisfies WorkerResponse);

			sliceStart = nextSliceStart;
		}

		self.postMessage({
			type: "transcribe-complete",
			text: segments.map((segment) => segment.text).join(" ").trim(),
			segments,
		} satisfies WorkerResponse);
	} catch (error) {
		if (cancelled) return;
		self.postMessage({
			type: "transcribe-error",
			error: error instanceof Error ? error.message : "Transcription failed",
		} satisfies WorkerResponse);
	}
}
