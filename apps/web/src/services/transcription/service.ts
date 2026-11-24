import type {
	TranscriptionLanguage,
	TranscriptionResult,
	TranscriptionProgress,
	TranscriptionModelId,
} from "@/transcription/types";
import {
	DEFAULT_TRANSCRIPTION_MODEL,
	TRANSCRIPTION_MODELS,
} from "@/transcription/models";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/transcription/audio";
import type { WorkerMessage, WorkerResponse } from "./worker";

type ProgressCallback = (progress: TranscriptionProgress) => void;

// 看门狗阈值。模型下载受网络影响给足 5 分钟；转写阶段每 90s 音频切片
// 必然产生至少一条进度消息，3 分钟无消息即视为 worker 已挂（OOM 崩溃
// 不会触发 try/catch，只能靠这条兜底把 Promise 从 pending 里救出来）。
const INIT_WATCHDOG_MS = 5 * 60_000;
const TRANSCRIBE_WATCHDOG_MS = 3 * 60_000;

class TranscriptionService {
	private worker: Worker | null = null;
	private currentModelId: TranscriptionModelId | null = null;
	private isInitialized = false;
	private isInitializing = false;
	/** Set by cancel(); checked before/after model loading so a cancel during
	 * weight download is not silently swallowed (worker answers "cancelled"
	 * before the transcribe listener is attached). */
	private cancelled = false;
	/** 只在 transcribe 进行期间存在：把 watchdog 超时/worker 崩溃路由给调用方。 */
	private pendingFail: ((error: Error) => void) | null = null;
	private watchdogTimer: ReturnType<typeof setInterval> | null = null;
	private watchdogTimeoutMs = 0;
	private watchdogLastMessageAt = 0;

	async transcribe({
		audioData,
		language = "auto",
		modelId = DEFAULT_TRANSCRIPTION_MODEL,
		sampleRate = DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
		onProgress,
	}: {
		audioData: Float32Array;
		language?: TranscriptionLanguage;
		modelId?: TranscriptionModelId;
		/** audioData 的采样率（audio.ts 的 16kHz 常量）。 */
		sampleRate?: number;
		onProgress?: ProgressCallback;
	}): Promise<TranscriptionResult> {
		this.cancelled = false;
		await this.ensureWorker({ modelId, onProgress });
		if (this.cancelled) {
			throw new Error("Transcription cancelled");
		}
		// 模型就绪后立刻报 转写中 0%：文件下载进度停在 100% 之后还有一段
		// ORT 会话编译的静默期（无回调），不切阶段的话 UI 会一直停在
		// 「加载模型 100%」看起来像卡死。第一片转写完成前都显示 0%。
		onProgress?.({
			status: "transcribing",
			progress: 0,
			message: "Transcribing audio...",
		});

		return new Promise((resolve, reject) => {
			if (!this.worker) {
				reject(new Error("Worker not initialized"));
				return;
			}

			const settle = (finish: () => void) => {
				this.worker?.removeEventListener("message", handleMessage);
				this.pendingFail = null;
				this.disarmWatchdog();
				finish();
			};

			const handleMessage = (event: MessageEvent<WorkerResponse>) => {
				this.touchWatchdog();
				const response = event.data;

				switch (response.type) {
					case "transcribe-progress":
						onProgress?.({
							status: "transcribing",
							progress: response.progress,
							message: "Transcribing audio...",
						});
						break;

					case "transcribe-start":
						console.info(
							`[transcription] 开始转写: 音频 ${response.totalSeconds.toFixed(1)}s, 语言 ${response.language}`,
						);
						break;

					case "device-fallback":
						// WebGPU 推理挂起，worker 已自行降级 CPU(wasm) 并重跑当前切片
						console.info(
							"[transcription] WebGPU 推理无响应，已降级 CPU(wasm) 继续",
						);
						break;

					case "slice-debug":
						console.info(
							response.rms < 0
								? `[transcription] slice ${response.start.toFixed(1)}s-${response.end.toFixed(1)}s 推理中...`
								: `[transcription] slice ${response.start.toFixed(1)}s-${response.end.toFixed(1)}s rms=${response.rms.toFixed(4)} chunks=${response.chunks}`,
						);
						break;

					case "transcribe-complete":
						settle(() =>
							resolve({
								text: response.text,
								segments: response.segments,
								language: response.language || language,
							}),
						);
						break;

					case "transcribe-error":
						settle(() => reject(new Error(response.error)));
						break;

					case "cancelled":
						settle(() => reject(new Error("Transcription cancelled")));
						break;
				}
			};

			this.worker.addEventListener("message", handleMessage);
			// OOM 崩掉的是整个线程：onmessage 不会来，onerror 会。
			this.worker.onerror = (event) => {
				settle(() =>
					reject(
						new Error(
							event.message || "Transcription worker crashed",
						),
					),
				);
			};
			this.pendingFail = (error) => reject(error);
			this.armWatchdog(TRANSCRIBE_WATCHDOG_MS);

			// Transferable 零拷贝：长音频的 Float32Array 有 100MB+，结构化
			// 克隆会再翻一倍内存。移交后调用方不得再读 audioData（调用方已知）。
			const transfer: Transferable[] = [];
			if (audioData.buffer instanceof ArrayBuffer) {
				transfer.push(audioData.buffer);
			}
			this.worker.postMessage(
				{
					type: "transcribe",
					audio: audioData,
					language,
					sampleRate,
				} satisfies WorkerMessage,
				transfer,
			);
		});
	}

	cancel() {
		this.cancelled = true;
		this.worker?.postMessage({ type: "cancel" } satisfies WorkerMessage);
	}

	private async ensureWorker({
		modelId,
		onProgress,
	}: {
		modelId: TranscriptionModelId;
		onProgress?: ProgressCallback;
	}): Promise<void> {
		const needsNewModel = this.currentModelId !== modelId;

		if (this.worker && this.isInitialized && !needsNewModel) {
			return;
		}

		if (this.isInitializing && !needsNewModel) {
			await this.waitForInit();
			return;
		}

		this.terminate();
		this.isInitializing = true;
		this.isInitialized = false;

		const model = TRANSCRIPTION_MODELS.find((m) => m.id === modelId);
		if (!model) {
			throw new Error(`Unknown model: ${modelId}`);
		}

		this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
			type: "module",
		});

		return new Promise((resolve, reject) => {
			if (!this.worker) {
				reject(new Error("Failed to create worker"));
				return;
			}

			const settle = (finish: () => void) => {
				this.worker?.removeEventListener("message", handleMessage);
				this.disarmWatchdog();
				finish();
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
						settle(() => {
							this.isInitialized = true;
							this.isInitializing = false;
							this.currentModelId = modelId;
							console.info(
								`[transcription] 模型就绪 (backend: ${response.device})`,
							);
							resolve();
						});
						break;

					case "init-error":
						settle(() => {
							this.isInitializing = false;
							this.terminate();
							reject(new Error(response.error));
						});
						break;

					case "cancelled":
						// Cancel arrived while weights were still downloading: the
						// transcribe listener does not exist yet, so handle it here
						// and drop the worker instead of loading the model anyway.
						settle(() => {
							this.isInitializing = false;
							this.isInitialized = false;
							this.terminate();
							reject(new Error("Transcription cancelled"));
						});
						break;
				}
			};

			this.worker.addEventListener("message", handleMessage);
			this.worker.onerror = (event) => {
				settle(() => {
					this.isInitializing = false;
					this.terminate();
					reject(
						new Error(
							event.message || "Transcription worker crashed during init",
						),
					);
				});
			};
			// 首次加载含权重下载，窗口放宽
			this.armWatchdog(INIT_WATCHDOG_MS);

			this.worker.postMessage({
				type: "init",
				modelId: model.huggingFaceId,
			} satisfies WorkerMessage);
		});
	}

	/** worker 无消息超时 → 终止并把失败路由给正在等待的 transcribe 调用。 */
	private armWatchdog(timeoutMs: number): void {
		this.disarmWatchdog();
		this.watchdogTimeoutMs = timeoutMs;
		this.watchdogLastMessageAt = Date.now();
		this.watchdogTimer = setInterval(() => {
			if (Date.now() - this.watchdogLastMessageAt <= this.watchdogTimeoutMs) {
				return;
			}
			this.disarmWatchdog();
			this.terminate();
			const fail = this.pendingFail;
			this.pendingFail = null;
			fail?.(new Error("Transcription stalled (no worker activity)"));
		}, 5000);
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
			const checkInit = () => {
				if (this.isInitialized) {
					resolve();
				} else if (!this.isInitializing) {
					resolve();
				} else {
					setTimeout(checkInit, 100);
				}
			};
			checkInit();
		});
	}

	terminate() {
		this.disarmWatchdog();
		this.pendingFail = null;
		this.worker?.terminate();
		this.worker = null;
		this.isInitialized = false;
		this.isInitializing = false;
		this.currentModelId = null;
	}
}

export const transcriptionService = new TranscriptionService();
