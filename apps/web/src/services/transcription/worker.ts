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
import { logger } from "@/services/logging/logger";
import type { TranscriptionDevice } from "./strategy";

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

/**
 * 只约束 GPU 路径的超时。导出成可变对象是为了测试能调小，业务代码不要改。
 * CPU 路径不设 worker 侧超时：弱 CPU 上一个切片跑几分钟是正常的，真挂死
 * 由主线程看门狗兜底（见 service.ts）。
 */
export const transcriptionTimeouts = {
	/** GPU 建会话：多久没有下载进度就视为挂起（下载慢不算，回调会续期）。 */
	webgpuInitStallMs: 120_000,
	/** GPU 推理：单个切片超过多久就视为挂起。 */
	webgpuSliceMs: 90_000,
};

export type WorkerMessage =
	| { type: "init"; modelId: string; device: TranscriptionDevice }
	| {
			type: "transcribe";
			audio: Float32Array;
			language: string;
			sampleRate: number;
			/** 从第几个采样点开始转写：GPU 失败后由 CPU worker 从出事的切片续跑。 */
			startFromSample?: number;
	  }
	| { type: "cancel" };

export type WorkerResponse =
	| { type: "init-progress"; progress: number }
	| { type: "init-complete"; device: TranscriptionDevice }
	| { type: "init-error"; error: string }
	/**
	 * 一个切片转完了。字幕随进度逐片上报而不是攒到最后：GPU 中途失败时
	 * 旧 worker 会被销毁，已经转完的部分必须已经在主线程手里。
	 */
	| {
			type: "transcribe-progress";
			progress: number;
			/** 刚转完的这个切片落进其辖区的字幕（时间戳为相对整段音频的绝对秒）。 */
			segments: TranscriptionSegment[];
	  }
	| {
			type: "transcribe-complete";
			text: string;
			segments: TranscriptionSegment[];
			language?: string;
	  }
	| { type: "transcribe-error"; error: string }
	| { type: "cancelled" }
	/**
	 * GPU 不可用（建会话失败或挂住、推理报错或挂住）。worker 自己不换设备：
	 * 崩过一次的 ORT / GPU 状态不可信，由主线程销毁本 worker、用全新的 CPU
	 * worker 重建。推理阶段带上出事切片的起点供续跑。
	 */
	| {
			type: "device-fallback";
			phase: "init" | "slice";
			reason: string;
			fromSample?: number;
	  }
	| { type: "slice-heartbeat"; start: number; end: number }
	| { type: "transcribe-start"; totalSeconds: number; language: string }
	| {
			type: "slice-debug";
			start: number;
			end: number;
			rms: number;
			chunks: number;
			startSample: number;
	  };

/** worker 全局作用域里转写逻辑用到的最小接口：真实环境传 self，测试传替身。 */
export interface TranscriptionWorkerScope {
	readonly location: { origin: string };
	postMessage: (response: WorkerResponse) => void;
}

export interface TranscriptionWorkerHandlers {
	onmessage: (event: { data: WorkerMessage }) => void;
	onerror: (event: unknown) => void;
}

class InitStallError extends Error {}
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
				() =>
					reject(
						new SliceTimeoutError(`inference timeout after ${timeoutMs}ms`),
					),
				timeoutMs,
			);
		}),
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

/**
 * 静默超时：每调一次 rearm() 重新计时。用于 GPU 建会话——权重下载慢不是
 * 挂起（进度回调持续到来），只有进度停了超过 stallMs 才判定卡死。
 */
function withStallTimeout<T>({
	promise,
	stallMs,
}: {
	promise: Promise<T>;
	stallMs: number;
}): { result: Promise<T>; rearm: () => void } {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let rejectStall: (error: InitStallError) => void = () => {};
	const stall = new Promise<never>((_, reject) => {
		rejectStall = reject;
	});
	const rearm = (): void => {
		if (timer !== undefined) clearTimeout(timer);
		timer = setTimeout(
			() =>
				rejectStall(
					new InitStallError(
						`Model load stalled (no progress for ${Math.round(stallMs / 1000)}s)`,
					),
				),
			stallMs,
		);
	};
	rearm();
	const result = Promise.race([promise, stall]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
	return { result, rearm };
}

/**
 * 把转写逻辑装到一个 worker 全局作用域上。写成工厂而不是模块级状态：
 * 状态随作用域走，每个 worker 一份，测试里给每个假 worker 各建一份即可。
 */
export function createTranscriptionWorker(
	scope: TranscriptionWorkerScope,
): TranscriptionWorkerHandlers {
	const post = (response: WorkerResponse): void => {
		scope.postMessage(response);
	};

	let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
	/** 本 worker 固定使用的设备，由主线程按机器策略指定（见 strategy.ts）。 */
	let device: TranscriptionDevice = "wasm";
	let cancelled = false;
	/** 已上报 GPU 不可用：主线程销毁本 worker 之前不再处理任何消息。 */
	let abandoned = false;

	/**
	 * 长推理（wasm 慢 CPU）期间定期心跳：主线程看门狗对所有消息都会续期，
	 * 有心跳就永远不会把「慢但活着」的推理误判成「挂起」。注意同步 wasm 推理
	 * 期间事件循环被占住，心跳发不出来，所以主线程对 CPU 切片另行放宽了阈值。
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
			post({ type: "slice-heartbeat", start, end });
		}, intervalMs);
		try {
			return await promise;
		} finally {
			clearInterval(timer);
		}
	}

	const fileBytes = new Map<string, { loaded: number; total: number }>();
	let lastReportedProgress = -1;
	let lastProgressPostedAt = 0;
	let rearmInitStall: (() => void) | null = null;

	/** 权重是否还没下完。失败时用来区分「网络问题」和「会话建不起来」。 */
	function hasIncompleteDownload(): boolean {
		for (const { loaded, total } of fileBytes.values()) {
			if (loaded < total) return true;
		}
		return false;
	}

	function handleInitProgress(progressInfo: {
		status?: string;
		file?: string;
		loaded?: number;
		total?: number;
	}): void {
		rearmInitStall?.();

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
		for (const { loaded: fileLoaded, total: fileTotal } of fileBytes.values()) {
			totalLoaded += fileLoaded;
			totalSize += fileTotal;
		}

		if (totalSize === 0) return;

		const overallProgress = (totalLoaded / totalSize) * 100;
		const roundedProgress = Math.floor(overallProgress);

		// 整数百分比变了才上报；百分比不变时最多每秒补发一条——主线程看门狗
		// 靠消息续期，大模型在慢网络下 1% 可能要几分钟。
		const now = Date.now();
		if (
			roundedProgress === lastReportedProgress &&
			now - lastProgressPostedAt < 1_000
		) {
			return;
		}
		lastReportedProgress = roundedProgress;
		lastProgressPostedAt = now;
		post({ type: "init-progress", progress: roundedProgress });
	}

	async function createTranscriber({
		modelId,
		device: requestedDevice,
	}: {
		modelId: string;
		device: TranscriptionDevice;
	}): Promise<AutomaticSpeechRecognitionPipeline> {
		// device 用字面量分支调用：union 变量传入会让 TS 推导爆炸（TS2590），
		// 又得靠断言收口（会触发 no-unsafe-type-assertion）。
		if (requestedDevice === "wasm") {
			return pipeline("automatic-speech-recognition", modelId, {
				dtype: "q4",
				device: "wasm",
				progress_callback: handleInitProgress,
			});
		}

		// GPU 建会话可能整体挂住（promise 永不 resolve）：权重下载期间进度回调
		// 持续到来，每次回调给静默计时续期；只有进度停了才算挂起。
		const guarded = withStallTimeout({
			promise: pipeline("automatic-speech-recognition", modelId, {
				dtype: "q4",
				device: "webgpu",
				progress_callback: handleInitProgress,
			}),
			stallMs: transcriptionTimeouts.webgpuInitStallMs,
		});
		rearmInitStall = guarded.rearm;
		try {
			return await guarded.result;
		} finally {
			rearmInitStall = null;
		}
	}

	async function handleInit({
		modelId,
		device: requestedDevice,
	}: {
		modelId: string;
		device: TranscriptionDevice;
	}) {
		lastReportedProgress = -1;
		lastProgressPostedAt = 0;
		fileBytes.clear();
		device = requestedDevice;

		try {
			transcriber = await createTranscriber({
				modelId,
				device: requestedDevice,
			});
			logger.info("transcription model ready", {
				device: requestedDevice,
				model: modelId,
			});
			post({ type: "init-complete", device: requestedDevice });
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "Failed to load model";
			logger.error("transcription model init failed", {
				device: requestedDevice,
				model: modelId,
				download_incomplete: hasIncompleteDownload(),
				error: message,
			});

			// GPU 会话建不起来 / 建到一半挂住：交给主线程换 CPU 重建。权重还没下完
			// 就失败的多半是网络问题，换设备无济于事，直接报错。
			if (requestedDevice === "webgpu" && !hasIncompleteDownload()) {
				post({ type: "device-fallback", phase: "init", reason: message });
				return;
			}
			post({ type: "init-error", error: message });
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
		startFromSample = 0,
	}: {
		audio: Float32Array;
		language: string;
		sampleRate: number;
		startFromSample?: number;
	}) {
		if (!transcriber) {
			post({ type: "transcribe-error", error: "Model not initialized" });
			return;
		}

		cancelled = false;

		const totalSamples = audio.length;

		// 观测：实际进入推理的音频总长。若远小于时间轴时长，说明提取阶段截断。
		post({
			type: "transcribe-start",
			totalSeconds: totalSamples / sampleRate,
			language,
		});
		const sliceSamples = Math.max(1, Math.floor(SLICE_SECONDS * sampleRate));
		const overlapSamples = Math.min(
			sliceSamples - 1,
			Math.floor(OVERLAP_SECONDS * sampleRate),
		);

		/** 全部时间戳已换算为相对整段音频的绝对秒。 */
		const segments: TranscriptionSegment[] = [];

		// 续跑起点：GPU 失败后 CPU worker 从出事的那个切片开始，前面已转写的
		// 部分不重做。切片边界只取决于起点，所以续跑的切法和最初完全一致。
		let sliceStart = Math.min(
			Math.max(0, Math.floor(startFromSample)),
			Math.max(0, totalSamples - 1),
		);

		try {
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

				// 切片开始即上报：主线程据此记下续跑起点，并喂活看门狗
				post({
					type: "slice-debug",
					start: offsetSeconds,
					end: sliceEnd / sampleRate,
					rms: -1,
					chunks: -1,
					startSample: sliceStart,
				});

				const transcribeOptions = {
					chunk_length_s: DEFAULT_CHUNK_LENGTH_SECONDS,
					stride_length_s: DEFAULT_STRIDE_SECONDS,
					language: language === "auto" ? undefined : language,
					return_timestamps: true,
				};

				const inferPromise = transcriber(slice, transcribeOptions);
				// 超时弃用后原推理 promise 可能仍在跑，吞掉迟到的 rejection
				void inferPromise.catch(() => {});

				let rawResult:
					AutomaticSpeechRecognitionOutput | AutomaticSpeechRecognitionOutput[];
				try {
					rawResult =
						device === "webgpu"
							? await withTimeout({
									promise: inferPromise,
									timeoutMs: transcriptionTimeouts.webgpuSliceMs,
								})
							: await withHeartbeat({
									promise: inferPromise,
									start: offsetSeconds,
									end: sliceEnd / sampleRate,
								});
				} catch (error) {
					if (cancelled) return;

					if (device === "webgpu") {
						// GPU 推理报错或挂起（核显驱动上的 "table index is out of
						// bounds"、GPUBuffer 回读失败等）。本 worker 的 ORT / GPU 状态
						// 已经不可信，同设备重试只会复现：上报主线程，由它销毁本
						// worker、用全新的 CPU worker 从本切片续跑。
						const reason =
							error instanceof Error ? error.message : String(error);
						logger.warn("transcription webgpu inference failed", {
							slice_start: offsetSeconds,
							reason,
						});
						post({
							type: "device-fallback",
							phase: "slice",
							reason,
							fromSample: sliceStart,
						});
						abandoned = true;
						return;
					}

					// wasm 上的错误重试一次：内存紧张 / 瞬时解码错误多见于段边界
					logger.warn("transcription slice failed, retrying once", {
						slice_start: offsetSeconds,
						reason: error instanceof Error ? error.message : String(error),
					});
					const retryPromise = transcriber(slice, transcribeOptions);
					void retryPromise.catch(() => {});
					rawResult = await withHeartbeat({
						promise: retryPromise,
						start: offsetSeconds,
						end: sliceEnd / sampleRate,
					});
				}

				if (cancelled) return;

				const result: AutomaticSpeechRecognitionOutput = Array.isArray(
					rawResult,
				)
					? rawResult[0]
					: rawResult;

				// 重叠区去重：按 chunk 中点划归唯一辖区 [sliceStart, boundarySeconds)。
				// 中点落在上一切片辖区的（理论上不存在，防御性跳过）与落在下一切片
				// 辖区的（下片会重新识别）都不保留——旧实现把上界写成了保留条件
				// （中点 < 本片终点即跳过），导致每个切片只留下尾部 2s 重叠区的
				// 碎片，其余产出全部丢弃：字幕碎片化 + 大段空洞。
				const sliceSegments: TranscriptionSegment[] = [];
				if (result.chunks) {
					for (const chunk of result.chunks) {
						if (!chunk.timestamp || chunk.timestamp.length < 2) continue;
						const start = offsetSeconds + (chunk.timestamp[0] ?? 0);
						const end =
							offsetSeconds + (chunk.timestamp[1] ?? chunk.timestamp[0] ?? 0);
						const midpoint = (start + end) / 2;
						if (midpoint < offsetSeconds) continue;
						if (midpoint >= boundarySeconds) continue;
						sliceSegments.push({ text: chunk.text, start, end });
					}
				}
				segments.push(...sliceSegments);

				const processedSamples = Math.min(
					totalSamples,
					sliceStart + sliceSamples,
				);
				post({
					type: "transcribe-progress",
					progress: Math.min(100, (processedSamples / totalSamples) * 100),
					segments: sliceSegments,
				});

				// 诊断：切片 RMS 能量 + 本片产出条数。识别漏段 vs 音频本身静音，
				// 一条日志即可区分（RMS≈0 是音频没内容，RMS 高但 chunks=0 才是识别问题）。
				{
					let sumSquares = 0;
					for (let i = 0; i < slice.length; i++) {
						sumSquares += slice[i] * slice[i];
					}
					logger.debug("transcription slice done", {
						start: offsetSeconds,
						end: sliceEnd / sampleRate,
						rms: Math.sqrt(sumSquares / Math.max(1, slice.length)),
						chunks: result.chunks?.length ?? 0,
					});
				}

				sliceStart = nextSliceStart;
			}

			post({
				type: "transcribe-complete",
				text: segments
					.map((segment) => segment.text)
					.join(" ")
					.trim(),
				segments,
			});
		} catch (error) {
			if (cancelled) return;
			const message =
				error instanceof Error ? error.message : "Transcription failed";
			logger.error("transcription failed", { device, error: message });
			post({ type: "transcribe-error", error: message });
		}
	}

	const onmessage: TranscriptionWorkerHandlers["onmessage"] = async ({
		data,
	}) => {
		if (abandoned) return;
		switch (data.type) {
			case "init":
				await handleInit({ modelId: data.modelId, device: data.device });
				break;
			case "transcribe":
				await handleTranscribe(data);
				break;
			case "cancel":
				cancelled = true;
				post({ type: "cancelled" });
				break;
		}
	};

	// 线程级兜底：未捕获异常（含部分 OOM 场景）走这里，保证主线程的 Promise
	// 能收到失败而不是永远 pending。
	const onerror: TranscriptionWorkerHandlers["onerror"] = (event) => {
		const detail =
			typeof event === "string"
				? event
				: event instanceof ErrorEvent
					? event.message
					: "Transcription worker crashed";
		post({
			type: "transcribe-error",
			error: detail || "Transcription worker crashed",
		});
	};

	return { onmessage, onerror };
}

// 真实 worker 的入口：装到全局作用域上。
const workerHandlers = createTranscriptionWorker(self);
self.onmessage = workerHandlers.onmessage;
self.onerror = workerHandlers.onerror;
