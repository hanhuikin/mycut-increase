import type {
	TranscriptionLanguage,
	TranscriptionResult,
	TranscriptionProgress,
	TranscriptionModelId,
	TranscriptionModel,
	TranscriptionSegment,
} from "@/transcription/types";
import {
	DEFAULT_TRANSCRIPTION_MODEL,
	TRANSCRIPTION_MODELS,
} from "@/transcription/models";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/transcription/audio";
import { currentClientTraceId, logger } from "@/services/logging/logger";
import {
	announceDeviceDecision,
	refreshDeviceDecision,
	rememberGpuFailure,
	type DeviceDecision,
	type TranscriptionDevice,
} from "./strategy";
import type { WorkerMessage, WorkerResponse } from "./worker";

type ProgressCallback = (progress: TranscriptionProgress) => void;

/**
 * 主线程看门狗：worker 多久没有任何消息就视为挂死（OOM 崩掉线程、同步
 * wasm 把线程卡死，都不会再有消息，try/catch 和 onerror 都指望不上）。
 * 导出成可变对象是为了测试能调小，业务代码不要改。
 */
export const transcriptionWatchdog = {
	pollMs: 5_000,
	/** 加载模型：下载期间有 init-progress 续期，所以只防真挂死。 */
	initMs: 5 * 60_000,
	/** 转写：切片之间，以及 GPU 推理中（GPU 单切片另有 worker 侧超时）。 */
	transcribeMs: 3 * 60_000,
	/** 转写：CPU 模式下单个切片进行中——弱 CPU 上一个切片跑几分钟是正常的。 */
	wasmSliceMs: 15 * 60_000,
};

const CANCELLED_MESSAGE = "Transcription cancelled";

function isCancelledError(error: Error): boolean {
	return error.message === CANCELLED_MESSAGE;
}

type InitOutcome =
	| { kind: "ready" }
	| { kind: "gpu-failed"; error: string }
	| { kind: "cancelled" }
	| { kind: "error"; error: string };

type TranscribeOutcome =
	| { kind: "complete"; result: TranscriptionResult }
	| { kind: "gpu-failed"; fromSample: number; error: string };

/**
 * 字幕转写的 worker 管理。设备由 strategy.ts 按机器决定，worker 只负责
 * 「用指定设备转写」；GPU 出任何问题都上报到这里，由这里换成 CPU 续跑。
 *
 * 换设备一律销毁旧 worker、用全新的 worker 重建，不在原 worker 里重试：
 * 崩过的 ORT / GPU 会话连 dispose 都可能挂住，复用它降级等于在废墟上盖房。
 */
class TranscriptionService {
	private worker: Worker | null = null;
	private currentModelId: TranscriptionModelId | null = null;
	private isInitialized = false;
	private isInitializing = false;
	/** 当前（或正在创建的）worker 使用的设备。 */
	private device: TranscriptionDevice = "wasm";
	private cancelled = false;
	private watchdogTimer: ReturnType<typeof setInterval> | null = null;
	private watchdogTimeoutMs = 0;
	private watchdogLastMessageAt = 0;
	/**
	 * 当前未决操作的收口。看门狗超时、cancel()、外部 terminate() 都经它把
	 * 失败交给所属阶段——由阶段自己决定是改用 CPU 还是直接报错。
	 */
	private failPending: ((error: Error) => void) | null = null;
	private initWaiters: Array<() => void> = [];

	async transcribe({
		audioData,
		language = "auto",
		modelId = DEFAULT_TRANSCRIPTION_MODEL,
		sampleRate = DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
		onProgress,
		onDeviceFallback,
	}: {
		audioData: Float32Array;
		language?: TranscriptionLanguage;
		modelId?: TranscriptionModelId;
		/** audioData 的采样率（audio.ts 的 16kHz 常量）。 */
		sampleRate?: number;
		onProgress?: ProgressCallback;
		/** GPU 运行期失败、改用 CPU 续跑时回调一次（提示用户速度会变慢）。 */
		onDeviceFallback?: (info: { reason: string }) => void;
	}): Promise<TranscriptionResult> {
		this.cancelled = false;
		// 按机器策略选设备：独显 → GPU；核显 / 无 GPU → CPU；失败过的 → CPU
		let decision = await refreshDeviceDecision();
		await this.ensureWorker({ modelId, decision, onProgress });
		if (this.cancelled) throw new Error(CANCELLED_MESSAGE);

		// 模型就绪后立刻报 转写中 0%：文件下载进度停在 100% 之后还有一段
		// ORT 会话编译的静默期（无回调），不切阶段的话 UI 会一直停在
		// 「加载模型 100%」看起来像卡死。第一片转写完成前都显示 0%。
		onProgress?.({
			status: "transcribing",
			progress: 0,
			message: "Transcribing audio...",
		});

		// 字幕由主线程逐片收集：GPU 中途失败时旧 worker 连同它内存里的中间
		// 结果一起销毁，已经转完的切片必须在主线程这里留着，才能和 CPU 续跑
		// 的部分拼成完整结果。
		const segments: TranscriptionSegment[] = [];
		let startFromSample = 0;
		for (;;) {
			const outcome = await this.runTranscribe({
				audioData,
				language,
				sampleRate,
				onProgress,
				segments,
				startFromSample,
			});
			if (outcome.kind === "complete") return outcome.result;
			if (this.cancelled) throw new Error(CANCELLED_MESSAGE);

			// 能走到这里只可能是 GPU 运行期失败（推理报错或挂住、worker 崩溃
			// 或失联）。记下这块 GPU，这台机器此后直接用 CPU；本次转写换 CPU
			// 从出事的切片续跑，已经转写完的部分不重做。
			logger.warn("transcription GPU failed; switching to CPU", {
				from_sample: outcome.fromSample,
				reason: outcome.error,
			});
			rememberGpuFailure();
			decision = { device: "wasm", reason: "gpu-failed", gpu: decision.gpu };
			announceDeviceDecision(decision);
			await this.ensureWorker({ modelId, decision, onProgress });
			if (this.cancelled) throw new Error(CANCELLED_MESSAGE);
			startFromSample = outcome.fromSample;
			onDeviceFallback?.({ reason: outcome.error });
		}
	}

	cancel(): void {
		this.cancelled = true;
		if (!this.worker) return;
		// CPU 推理是同步 wasm：整片跑完之前 worker 根本收不到 cancel 消息，直接
		// 销毁 worker 才能立刻停下来（下次转写重新加载模型，只要几秒）。
		if (this.device === "wasm" && this.failPending) {
			this.failPending(new Error(CANCELLED_MESSAGE));
			return;
		}
		this.worker.postMessage({ type: "cancel" } satisfies WorkerMessage);
	}

	/** 外部主动终止（例如用户改了加速方式）：进行中的转写按取消处理。 */
	terminate(): void {
		this.cancelled = true;
		this.dropWorker();
	}

	private async ensureWorker({
		modelId,
		decision,
		onProgress,
	}: {
		modelId: TranscriptionModelId;
		decision: DeviceDecision;
		onProgress?: ProgressCallback;
	}): Promise<void> {
		const reusable =
			this.worker !== null &&
			this.isInitialized &&
			this.currentModelId === modelId &&
			this.device === decision.device;
		if (reusable) return;

		if (
			this.isInitializing &&
			this.currentModelId === modelId &&
			this.device === decision.device
		) {
			await this.waitForInit();
			if (!this.isInitialized) {
				throw new Error(`Failed to load model: ${modelId}`);
			}
			return;
		}

		const model = TRANSCRIPTION_MODELS.find((m) => m.id === modelId);
		if (!model) {
			throw new Error(`Unknown model: ${modelId}`);
		}

		this.dropWorker();
		this.currentModelId = modelId;

		let activeDecision = decision;
		for (;;) {
			this.device = activeDecision.device;
			const outcome = await this.initWorker({ model, onProgress });
			if (outcome.kind === "ready") {
				// initWorker 内部会先 dropWorker（它会清掉 currentModelId），
				// 所以这里必须把模型记回来，否则每次转写都会重建会话
				this.currentModelId = modelId;
				return;
			}
			if (outcome.kind === "cancelled") throw new Error(CANCELLED_MESSAGE);
			if (outcome.kind !== "gpu-failed") throw new Error(outcome.error);

			// GPU 会话建不起来，或建到一半挂住：换 CPU 重建。这里不写失败
			// 记忆——加载阶段的失败未必是 GPU 的锅，只有推理阶段失败才足以
			// 判定这块 GPU 不可用（见 transcribe）。
			logger.warn(
				"transcription GPU unavailable while loading the model; switching to CPU",
				{ reason: outcome.error },
			);
			activeDecision = {
				device: "wasm",
				reason: "gpu-failed",
				gpu: activeDecision.gpu,
			};
			announceDeviceDecision(activeDecision);
		}
	}

	private initWorker({
		model,
		onProgress,
	}: {
		model: TranscriptionModel;
		onProgress?: ProgressCallback;
	}): Promise<InitOutcome> {
		return new Promise((resolve) => {
			this.dropWorker();
			const usingGpu = this.device === "webgpu";
			const worker = new Worker(new URL("./worker.ts", import.meta.url), {
				type: "module",
			});
			this.worker = worker;
			this.isInitializing = true;
			this.isInitialized = false;
			let settled = false;

			const settle = (outcome: InitOutcome) => {
				if (settled) return;
				settled = true;
				worker.removeEventListener("message", handleMessage);
				this.failPending = null;
				this.disarmWatchdog();
				if (outcome.kind === "ready") {
					this.isInitialized = true;
					this.isInitializing = false;
					logger.info("transcription model ready", {
						device: this.device,
						model: model.id,
					});
				} else {
					this.dropWorker();
				}
				this.resolveInitWaiters();
				resolve(outcome);
			};

			const fail = (error: Error) => {
				if (isCancelledError(error)) {
					settle({ kind: "cancelled" });
					return;
				}
				logger.error("transcription model load failed", {
					device: this.device,
					error: error.message,
				});
				settle(
					usingGpu
						? { kind: "gpu-failed", error: error.message }
						: { kind: "error", error: error.message },
				);
			};

			const handleMessage = (event: MessageEvent<WorkerResponse>) => {
				this.touchWatchdog();
				const response = event.data;
				switch (response.type) {
					case "init-progress":
						onProgress?.({
							status: "loading-model",
							progress: response.progress,
							message: `Loading ${model.name} model...`,
						});
						break;

					case "init-complete":
						settle({ kind: "ready" });
						break;

					case "init-error":
						// worker 已经判定过这不是 GPU 的问题（例如权重没下完），
						// 换设备无济于事，直接报错
						settle({ kind: "error", error: response.error });
						break;

					case "device-fallback":
						// 只有 GPU worker 会发它；fail 据此归为 GPU 不可用
						fail(new Error(response.reason));
						break;

					case "cancelled":
						// Cancel arrived while weights were still downloading: the
						// transcribe listener does not exist yet, so handle it here
						// and drop the worker instead of loading the model anyway.
						settle({ kind: "cancelled" });
						break;

					default:
						break;
				}
			};

			worker.addEventListener("message", handleMessage);
			// OOM 崩掉的是整个线程：onmessage 不会来，onerror 会。
			worker.onerror = (event) => {
				fail(
					new Error(
						event.message || "Transcription worker crashed during init",
					),
				);
			};
			this.failPending = fail;
			// 首次加载含权重下载，窗口放宽
			this.armWatchdog(transcriptionWatchdog.initMs);

			worker.postMessage({
				type: "init",
				modelId: model.huggingFaceId,
				device: this.device,
				traceId: currentClientTraceId(),
			} satisfies WorkerMessage);
		});
	}

	/** 向当前 worker 提交转写；GPU 失败以 gpu-failed 返回，由调用方换 CPU 续跑。 */
	private runTranscribe({
		audioData,
		language,
		sampleRate,
		onProgress,
		segments,
		startFromSample,
	}: {
		audioData: Float32Array;
		language: TranscriptionLanguage;
		sampleRate: number;
		onProgress?: ProgressCallback;
		/** 逐片收集字幕的共享数组：续跑的 worker 往后追加。 */
		segments: TranscriptionSegment[];
		startFromSample: number;
	}): Promise<TranscribeOutcome> {
		return new Promise((resolve, reject) => {
			const worker = this.worker;
			if (!worker) {
				reject(new Error("Worker not initialized"));
				return;
			}
			const usingGpu = this.device === "webgpu";
			// 出故障时从哪个采样点续跑：worker 上报了就用它；失联时退而取
			// 最近一个切片的起点。
			let sliceStartSample = startFromSample;
			let settled = false;

			const settle = (finish: () => void) => {
				if (settled) return;
				settled = true;
				worker.removeEventListener("message", handleMessage);
				this.failPending = null;
				this.disarmWatchdog();
				finish();
			};

			const fail = (error: Error) => {
				if (!usingGpu) {
					settle(() => {
						this.dropWorker();
						reject(error);
					});
					return;
				}
				const fromSample = sliceStartSample;
				settle(() => {
					// 直接销毁，不 dispose：崩过的 GPU 会话连 dispose 都可能挂住
					this.dropWorker();
					resolve({ kind: "gpu-failed", fromSample, error: error.message });
				});
			};

			const handleMessage = (event: MessageEvent<WorkerResponse>) => {
				this.touchWatchdog();
				const response = event.data;

				switch (response.type) {
					case "transcribe-progress":
						this.setWatchdogLimit(transcriptionWatchdog.transcribeMs);
						segments.push(...response.segments);
						onProgress?.({
							status: "transcribing",
							progress: response.progress,
							message: "Transcribing audio...",
						});
						break;

					case "slice-debug":
						if (response.rms < 0) {
							sliceStartSample = response.startSample;
							// CPU 推理是同步 wasm：一个切片跑几分钟期间不会有任何
							// 消息，心跳也发不出来，看门狗要放宽到切片级
							this.setWatchdogLimit(
								usingGpu
									? transcriptionWatchdog.transcribeMs
									: transcriptionWatchdog.wasmSliceMs,
							);
						}
						break;

					case "slice-heartbeat":
						// 顶部已续期看门狗，静默即可
						break;

					case "transcribe-start":
						logger.debug("transcription started", {
							device: this.device,
							total_seconds: response.totalSeconds,
							language: response.language,
						});
						break;

					case "transcribe-complete":
						settle(() =>
							resolve({
								kind: "complete",
								// 用主线程收集到的整段字幕，而不是 worker 自己那份：
								// 续跑的 worker 只知道它接手之后的部分
								result: {
									text: segments
										.map((segment) => segment.text)
										.join(" ")
										.trim(),
									segments,
									language: response.language || language,
								},
							}),
						);
						break;

					case "transcribe-error":
						settle(() => reject(new Error(response.error)));
						break;

					case "device-fallback":
						if (!usingGpu) {
							settle(() => reject(new Error(response.reason)));
							break;
						}
						sliceStartSample = response.fromSample ?? sliceStartSample;
						fail(new Error(response.reason));
						break;

					case "cancelled":
						settle(() => reject(new Error(CANCELLED_MESSAGE)));
						break;

					default:
						// init-* 消息不会出现在转写阶段
						break;
				}
			};

			worker.addEventListener("message", handleMessage);
			// OOM 崩掉的是整个线程：onmessage 不会来，onerror 会。
			worker.onerror = (event) => {
				logger.error("transcription worker crashed", {
					device: this.device,
					error: event.message,
				});
				fail(new Error(event.message || "Transcription worker crashed"));
			};
			this.failPending = fail;
			this.armWatchdog(transcriptionWatchdog.transcribeMs);

			// Transferable 零拷贝：长音频的 Float32Array 有 100MB+，结构化
			// 克隆会再翻一倍内存。移交后调用方不得再读 audioData（调用方已知）。
			// GPU 模式例外：worker 随时可能因 GPU 故障被销毁，主线程必须自己
			// 留一份音频才能换 CPU 续跑。CPU 模式没有回退路径，照旧移交。
			const transfer: Transferable[] = [];
			if (!usingGpu && audioData.buffer instanceof ArrayBuffer) {
				transfer.push(audioData.buffer);
			}
			worker.postMessage(
				{
					type: "transcribe",
					audio: audioData,
					language,
					sampleRate,
					startFromSample,
				} satisfies WorkerMessage,
				transfer,
			);
		});
	}

	/** worker 无消息超时 → 交给当前未决的操作处理（改用 CPU 或报错）。 */
	private armWatchdog(timeoutMs: number): void {
		this.disarmWatchdog();
		this.watchdogTimeoutMs = timeoutMs;
		this.watchdogLastMessageAt = Date.now();
		this.watchdogTimer = setInterval(() => {
			if (Date.now() - this.watchdogLastMessageAt <= this.watchdogTimeoutMs) {
				return;
			}
			this.disarmWatchdog();
			const fail = this.failPending;
			if (!fail) return;
			logger.error("transcription worker stalled", {
				device: this.device,
				silent_ms: this.watchdogTimeoutMs,
			});
			fail(new Error("Transcription stalled (no worker activity)"));
		}, transcriptionWatchdog.pollMs);
	}

	private setWatchdogLimit(timeoutMs: number): void {
		this.watchdogTimeoutMs = timeoutMs;
	}

	private touchWatchdog(): void {
		this.watchdogLastMessageAt = Date.now();
	}

	private disarmWatchdog(): void {
		if (this.watchdogTimer) {
			clearInterval(this.watchdogTimer);
			this.watchdogTimer = null;
		}
	}

	private waitForInit(): Promise<void> {
		return new Promise((resolve) => {
			this.initWaiters.push(resolve);
		});
	}

	private resolveInitWaiters(): void {
		const waiters = this.initWaiters;
		this.initWaiters = [];
		for (const resolve of waiters) resolve();
	}

	/** 销毁 worker 并清空状态；有操作还没收口时让它失败，而不是永远 pending。 */
	private dropWorker(): void {
		this.disarmWatchdog();
		const fail = this.failPending;
		this.failPending = null;
		this.worker?.terminate();
		this.worker = null;
		this.isInitialized = false;
		this.isInitializing = false;
		this.currentModelId = null;
		this.resolveInitWaiters();
		fail?.(new Error("Transcription worker terminated"));
	}
}

export const transcriptionService = new TranscriptionService();
