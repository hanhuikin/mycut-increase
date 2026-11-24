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

// 模型权重默认走魔搭（ModelScope）。原方案 hf-mirror.com 已失效：它现在对
// 所有文件 308 裸跳 huggingface.co，国内连不上官方站，转写初始化直接
// "Failed to fetch"。魔搭镜像了 onnx-community 的 whisper 仓库，且全链路带
// CORS（小文件 200 内联，大文件 302 → cdn-lfs-cn-*.modelscope.cn 后
// Access-Control-Allow-Origin: *，实测 ~8MB/s），resolve/main 也可用。
// 与 HF 路径结构只差一个 /models 前缀，改模板补上即可。注意
// whisper-medium 魔搭暂缺（见 transcription/models.ts）。
// 自建反代等 HF 兼容源可用 NEXT_PUBLIC_HF_ENDPOINT 覆盖（此时沿用 HF 模板）。
const hfEndpoint = process.env.NEXT_PUBLIC_HF_ENDPOINT;
if (hfEndpoint) {
	env.remoteHost = hfEndpoint;
} else {
	env.remoteHost = "https://modelscope.cn";
	env.remotePathTemplate = "models/{model}/resolve/{revision}/";
}
env.allowLocalModels = false;

// ONNX Runtime 的 wasm 二进制默认从 cdn.jsdelivr.net 拉（transformers.js 内部
// 硬编码，remoteHost 管不到这条路径），国内对 jsdelivr 间歇性不可达时同样
// "Failed to fetch"。构建期由 scripts/sync-ort-wasm.mjs 把 dist 里的 ort-wasm-*
// 拷进 public/ort/，这里改同源加载；文件带 etag，浏览器 304 校验不会反复重下。
// 路径必须是绝对 URL：turbopack 会把 worker 打包成 blob（worker loader 的
// __turbopack_context__.b(chunks)），blob worker 的脚本 base 不可用于相对路径
// 解析——emscripten 的同步 XHR 拿相对路径直接 "Invalid URL"。
const onnxWasmConfig = env.backends.onnx?.wasm;
if (onnxWasmConfig) {
	onnxWasmConfig.wasmPaths = `${self.location.origin}/ort/`;
	// 固定单线程。ONNX Runtime 的 wasm 多线程靠 emscripten pthread：
	// 跨域隔离页面（SharedArrayBuffer 可用）下会自动开 numThreads=4，
	// 但实测会话创建会永久挂起——页面主线程和 blob worker 里都会挂，
	// 不是 turbopack 打包的问题（对照实验：同页面 4 线程挂死 >95s，
	// 单线程 3s 内建好）。挂起的后果就是 UI 卡在「加载模型 100%」，
	// 无独显机器上必现。单线程虽然慢 2~3 倍，但稳定出结果：
	// 实测 RTF≈0.58（whisper-small q4，16 线程桌面 CPU，30s 音频 17.5s）。
	onnxWasmConfig.numThreads = 1;
}
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
	| { type: "init-complete"; device: "auto" | "wasm" }
	| { type: "init-error"; error: string }
	| { type: "transcribe-progress"; progress: number }
	| {
			type: "transcribe-complete";
			text: string;
			segments: TranscriptionSegment[];
			language?: string;
	  }
	| { type: "transcribe-error"; error: string }
	| { type: "cancelled" }
	| { type: "device-fallback"; device: "wasm" }
	| { type: "slice-heartbeat"; start: number; end: number }
	| { type: "transcribe-start"; totalSeconds: number; language: string }
	| { type: "transcribe-start"; totalSeconds: number; language: string }
	| {
			type: "slice-debug";
			start: number;
			end: number;
			rms: number;
			chunks: number;
	  };

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let currentModelId: string | null = null;
// "auto" 表示尚未降级过；超时降级后固定为 "wasm"，不再重复降级。
let currentDevice: "auto" | "wasm" = "auto";
let cancelled = false;
let lastReportedProgress = -1;
const fileBytes = new Map<string, { loaded: number; total: number }>();

class SliceTimeoutError extends Error {}

/** race 输掉后清掉 timer，避免悬挂的 reject 定时器。 */
function withTimeout<T>({
	promise,
	timeoutMs,
}: {
	promise: Promise<T>;
	timeoutMs: number;
}): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		promise,
		new Promise<never>((_, reject) => {
			timer = setTimeout(
				() => reject(new SliceTimeoutError(`inference timeout after ${timeoutMs}ms`)),
				timeoutMs,
			);
		}),
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

/**
 * 长推理（wasm 慢 CPU）期间定期心跳：主线程看门狗对所有消息都会续期，
 * 有心跳就永远不会把「慢但活着」的推理误判成「挂起」。
 */
async function withHeartbeat<T>({
	promise,
	start,
	end,
	intervalMs = 20_000,
}: {
	promise: Promise<T>;
	start: number;
	end: number;
	intervalMs?: number;
}): Promise<T> {
	const timer = setInterval(() => {
		self.postMessage({
			type: "slice-heartbeat",
			start,
			end,
		} satisfies WorkerResponse);
	}, intervalMs);
	try {
		return await promise;
	} finally {
		clearInterval(timer);
	}
}

/**
 * WebGPU 推理在部分驱动/GPU 上会整体挂起（promise 永不 resolve，事件循环
 * 仍存活）。切片超时 → 丢弃 webgpu 会话、用 wasm（CPU，稳定但慢）重建后
 * 重跑当前切片——异步等待期间事件循环空闲，降级可以自愈。
 */
const WEBGPU_PIPELINE_TIMEOUT_MS = 120_000;
const WASM_PIPELINE_TIMEOUT_MS = 240_000;
const WEBGPU_SLICE_TIMEOUT_MS = 90_000;

async function disposeTranscriber(): Promise<void> {
	const current = transcriber;
	transcriber = null;
	// 尽力释放：dispose 方法本身也要防（可选链只保护 current，不保护
	// dispose 不是函数的运行时变体），失败一律忽略——降级优先于清理
	try {
		if (current && typeof current.dispose === "function") {
			await current.dispose();
		}
	} catch {
		// 已释放/不支持的实现忽略
	}
}

async function createTranscriber({
	modelId,
	device,
	timeoutMs,
	onProgress,
}: {
	modelId: string;
	device: "auto" | "wasm";
	timeoutMs: number;
	onProgress?: (progressInfo: {
		status?: string;
		file?: string;
		loaded?: number;
		total?: number;
	}) => void;
}): Promise<AutomaticSpeechRecognitionPipeline> {
	// device 用字面量分支调用：union 变量传入会让 TS 推导爆炸（TS2590），
	// 又得靠断言收口（会触发 no-unsafe-type-assertion）。
	const created =
		device === "wasm"
			? await withTimeout({
					promise: pipeline(
						"automatic-speech-recognition",
						modelId,
						{
							dtype: "q4",
							device: "wasm",
							progress_callback: onProgress,
						},
					),
					timeoutMs,
				})
			: await withTimeout({
					promise: pipeline(
						"automatic-speech-recognition",
						modelId,
						{
							dtype: "q4",
							device: "auto",
							progress_callback: onProgress,
						},
					),
					timeoutMs,
				});
	return created;
}

	self.onmessage = async ({ data }: MessageEvent<WorkerMessage>) => {
		switch (data.type) {
			case "init":
				await handleInit({ modelId: data.modelId });
				break;
			case "transcribe":
				await handleTranscribe({
					audio: data.audio,
					language: data.language,
					sampleRate: data.sampleRate,
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
				: event instanceof ErrorEvent
					? event.message
					: "Transcription worker crashed";
		self.postMessage({
			type: "transcribe-error",
			error: detail || "Transcription worker crashed",
		} satisfies WorkerResponse);
	};

async function handleInit({ modelId }: { modelId: string }) {
	lastReportedProgress = -1;
	fileBytes.clear();
	currentModelId = modelId;
	currentDevice = "auto";

	try {
		transcriber = await createTranscriber({
			modelId,
			device: "auto",
			timeoutMs: WEBGPU_PIPELINE_TIMEOUT_MS,
			onProgress: (progressInfo) => {
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
		});

		self.postMessage({
			type: "init-complete",
			device: currentDevice,
		} satisfies WorkerResponse);
	} catch (error) {
		// auto（webgpu）会话创建超时/失败 → 降级 wasm 重建。权重此时多半已
		// 在 Cache Storage，重建只需重新编译会话。
		const timedOut = error instanceof SliceTimeoutError;
		if (!timedOut) {
			self.postMessage({
				type: "init-error",
				error:
					error instanceof Error ? error.message : "Failed to load model",
			} satisfies WorkerResponse);
			return;
		}

		await disposeTranscriber();
		currentDevice = "wasm";
		self.postMessage({
			type: "device-fallback",
			device: "wasm",
		} satisfies WorkerResponse);
		try {
			transcriber = await createTranscriber({
				modelId,
				device: "wasm",
				timeoutMs: WASM_PIPELINE_TIMEOUT_MS,
			});
			self.postMessage({
				type: "init-complete",
				device: currentDevice,
			} satisfies WorkerResponse);
		} catch (fallbackError) {
			self.postMessage({
				type: "init-error",
				error:
					fallbackError instanceof Error
						? fallbackError.message
						: "Failed to load model",
			} satisfies WorkerResponse);
		}
	}
}

// 分段转写参数。transformers.js 的 _call_whisper 会把所有 30s 窗口的特征
// 张量一次性建好再逐个生成——长音频一次喂入是 GB 级内存，WASM 堆直接 OOM，
// worker 崩掉后 UI 永远停在"转写中"。切片取 28s + 2s 重叠 = 每次喂给
// whisper 的恰好是 30s **原生窗口**：若切成 30s+2s 重叠（32s 输入），
// whisper 内部会再切出一个 12s 尾巴窗口，非原生长度窗口容易幻觉/漏识别
// （实测整段字幕碎片化 + 大段空洞）。峰值内存 MB 级；段间上报真实进度；
// 单段失败可重试。
const SLICE_SECONDS = 28;
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

	// 观测：实际进入推理的音频总长。若远小于时间轴时长，说明提取阶段截断。
	self.postMessage({
		type: "transcribe-start",
		totalSeconds: totalSamples / sampleRate,
		language,
	} satisfies WorkerResponse);
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

			// 切片开始即上报：主线程看门狗被喂活，console 里也能看到切片在推进
			self.postMessage({
				type: "slice-debug",
				start: offsetSeconds,
				end: sliceEnd / sampleRate,
				rms: -1,
				chunks: -1,
			} satisfies WorkerResponse);

			const transcribeOptions = {
				chunk_length_s: DEFAULT_CHUNK_LENGTH_SECONDS,
				stride_length_s: DEFAULT_STRIDE_SECONDS,
				language: language === "auto" ? undefined : language,
				return_timestamps: true,
			};

			// webgpu 路径带超时（挂起检测→降级 wasm）；wasm 路径不限时——
			// 弱 CPU 上一个切片可能要几分钟，靠心跳喂主线程看门狗而不是超时。
			const inferPromise = transcriber(slice, transcribeOptions);
			// 超时弃用后原推理 promise 可能仍在跑，吞掉迟到的 rejection
			void inferPromise.catch(() => {});

			let rawResult:
				| AutomaticSpeechRecognitionOutput
				| AutomaticSpeechRecognitionOutput[];
			try {
				rawResult =
					currentDevice === "auto"
						? await withTimeout({
								promise: inferPromise,
								timeoutMs: WEBGPU_SLICE_TIMEOUT_MS,
							})
						: await withHeartbeat({
								promise: inferPromise,
								start: offsetSeconds,
								end: sliceEnd / sampleRate,
							});
			} catch (error) {
				if (cancelled) return;

				if (error instanceof SliceTimeoutError) {
					// webgpu 推理挂起 → 降级 wasm 重建并重跑本切片（只降级一次）。
					// wasm 已是固定单线程（见文件头部 numThreads 注释）。
					if (currentDevice === "auto") {
						await disposeTranscriber();
						currentDevice = "wasm";
						self.postMessage({
							type: "device-fallback",
							device: "wasm",
						} satisfies WorkerResponse);
						await createTranscriber({
							modelId: currentModelId ?? "",
							device: "wasm",
							timeoutMs: WASM_PIPELINE_TIMEOUT_MS,
						});
						rawResult = await withHeartbeat({
							promise: transcriber(slice, transcribeOptions),
							start: offsetSeconds,
							end: sliceEnd / sampleRate,
						});
					} else {
						// 已经是 wasm 还超时：交给主线程看门狗兜底
						throw error;
					}
				} else {
					// 非超时错误重试一次：内存紧张/瞬时解码错误多见于段边界
					rawResult = await transcriber(slice, transcribeOptions);
				}
			}

			if (cancelled) return;

			const result: AutomaticSpeechRecognitionOutput = Array.isArray(rawResult)
				? rawResult[0]
				: rawResult;

			// 重叠区去重：按 chunk 中点划归唯一辖区 [sliceStart, boundarySeconds)。
			// 中点落在上一切片辖区的（理论上不存在，防御性跳过）与落在下一切片
			// 辖区的（下片会重新识别）都不保留——旧实现把上界写成了保留条件
			// （中点 < 本片终点即跳过），导致每个切片只留下尾部 2s 重叠区的
			// 碎片，其余产出全部丢弃：字幕碎片化 + 大段空洞。
			if (result.chunks) {
				for (const chunk of result.chunks) {
					if (!chunk.timestamp || chunk.timestamp.length < 2) continue;
					const start = offsetSeconds + (chunk.timestamp[0] ?? 0);
					const end = offsetSeconds + (chunk.timestamp[1] ?? chunk.timestamp[0] ?? 0);
					const midpoint = (start + end) / 2;
					if (midpoint < offsetSeconds) continue;
					if (midpoint >= boundarySeconds) continue;
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

			// 诊断：切片 RMS 能量 + 本片产出条数。识别漏段 vs 音频本身静音，
			// 一条日志即可区分（RMS≈0 是音频没内容，RMS 高但 chunks=0 才是识别问题）。
			{
				let sumSquares = 0;
				for (let i = 0; i < slice.length; i++) {
					sumSquares += slice[i] * slice[i];
				}
				self.postMessage({
					type: "slice-debug",
					start: offsetSeconds,
					end: sliceEnd / sampleRate,
					rms: Math.sqrt(sumSquares / Math.max(1, slice.length)),
					chunks: result.chunks?.length ?? 0,
				} satisfies WorkerResponse);
			}

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
