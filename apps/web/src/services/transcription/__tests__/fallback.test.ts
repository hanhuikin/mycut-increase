import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { TranscriptionProgress } from "@/transcription/types";
import type { WorkerMessage } from "../worker";
import {
	getDeviceDecision,
	hasRecentGpuFailure,
	writeDevicePreference,
} from "../strategy";
import { transcriptionService, transcriptionWatchdog } from "../service";
import {
	hang,
	idleCreatePipeline,
	makePipeline,
	pipelineMock,
	sliceOutput,
	transformersMock,
} from "./harness/transformers-mock";
import {
	fakeWorkers,
	installFakeWorkerGlobal,
	resetFakeWorkers,
	type PostedMessage,
} from "./harness/fake-worker";

/**
 * 降级链路的故障注入测试：跑的是真实的 worker.ts 和 service.ts，只把
 * transformers 换成替身。覆盖 GPU 在各个阶段出错 / 挂起 / 崩溃 / 失联时，
 * 都能换成全新的 CPU worker 续跑并把字幕转完。
 */

// 必须在任何 worker 模块实例被加载之前装好替身
mock.module("@huggingface/transformers", () => ({
	env: transformersMock.env,
	pipeline: pipelineMock,
}));

const SAMPLE_RATE = 16_000;
const MODEL = "onnx-community/whisper-small";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
	value: {
		getItem: (key: string) => storage.get(key) ?? null,
		setItem: (key: string, value: string) => void storage.set(key, value),
		removeItem: (key: string) => void storage.delete(key),
	},
	configurable: true,
});

// worker 模块的入口会把自己装到 self 上；bun 的 self 上没有 onmessage 之类的
// 属性，先换成一个空壳，避免弄脏全局对象。
Object.defineProperty(globalThis, "self", {
	value: {
		location: { origin: "http://localhost" },
		onmessage: null,
		onerror: null,
		postMessage: () => {},
	},
	configurable: true,
	writable: true,
});
const workerModule = await import("../worker");
const timeouts = workerModule.transcriptionTimeouts;
installFakeWorkerGlobal(async () => workerModule);

const originalConfig = {
	webgpuInitStallMs: timeouts.webgpuInitStallMs,
	webgpuSliceMs: timeouts.webgpuSliceMs,
	...transcriptionWatchdog,
};

/** 把等待类时长调小，测试里几十毫秒内就能触发超时 / 看门狗。 */
function shrinkTimers(): void {
	timeouts.webgpuInitStallMs = 30;
	transcriptionWatchdog.pollMs = 5;
	// 加载阶段保持秒级：假 worker 首次加载模块本身就要上百毫秒
	transcriptionWatchdog.initMs = 5_000;
	transcriptionWatchdog.transcribeMs = 60;
	transcriptionWatchdog.wasmSliceMs = 60;
}
shrinkTimers();

afterAll(() => {
	Object.assign(timeouts, {
		webgpuInitStallMs: originalConfig.webgpuInitStallMs,
		webgpuSliceMs: originalConfig.webgpuSliceMs,
	});
	Object.assign(transcriptionWatchdog, originalConfig);
});

function reset(): void {
	transcriptionService.terminate();
	resetFakeWorkers();
	storage.clear();
	transformersMock.createPipeline = idleCreatePipeline;
	shrinkTimers();
	// 默认强制 GPU：策略判定不必探测显卡，专测降级链路本身
	writeDevicePreference("gpu");
}

function makeAudio(seconds: number): Float32Array {
	return new Float32Array(seconds * SAMPLE_RATE).fill(0.1);
}

function withDeadline<T>({
	promise,
	ms = 5_000,
}: {
	promise: Promise<T>;
	ms?: number;
}): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const deadline = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`test deadline exceeded (${ms}ms)`)),
			ms,
		);
	});
	return Promise.race([promise, deadline]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

function transcribeEntryOf(
	worker: (typeof fakeWorkers)[number],
): PostedMessage {
	const posted = worker.posted.find(
		(entry) => entry.message.type === "transcribe",
	);
	if (!posted) {
		throw new Error("worker did not receive a transcribe message");
	}
	return posted;
}

function transcribeMessageOf(
	worker: (typeof fakeWorkers)[number],
): Extract<WorkerMessage, { type: "transcribe" }> {
	const { message } = transcribeEntryOf(worker);
	if (message.type !== "transcribe") {
		throw new Error("worker did not receive a transcribe message");
	}
	return message;
}

function texts(segments: Array<{ text: string }>): string[] {
	return segments.map((segment) => segment.text);
}

/** 70s 音频 → 三个切片，起点 0s / 26s / 52s。 */
const FAILED_SLICE = 26 * SAMPLE_RATE;

function transcribe70s(): Promise<{
	segments: Array<{ text: string; start: number }>;
}> {
	return withDeadline({
		promise: transcriptionService.transcribe({
			audioData: makeAudio(70),
			language: "zh",
		}),
	});
}

describe("GPU 运行期失败 → 换全新 CPU worker 续跑", () => {
	beforeEach(reset);

	test("GPU 在第二个切片推理报错：从该切片续跑，第一个切片不重做", async () => {
		const reason =
			"Failed to download data from buffer: wgpu::MapAsyncStatus value = 4";
		transformersMock.createPipeline = ({ device }) =>
			Promise.resolve(
				makePipeline({
					device,
					infer: ({ startSample }) =>
						device === "webgpu" && startSample === FAILED_SLICE
							? Promise.reject(new Error(reason))
							: Promise.resolve(sliceOutput({ device, startSample })),
				}),
			);

		const fallbacks: string[] = [];
		const progress: TranscriptionProgress[] = [];
		const audio = makeAudio(70);
		const result = await withDeadline({
			promise: transcriptionService.transcribe({
				audioData: audio,
				language: "zh",
				onProgress: (update) => void progress.push(update),
				onDeviceFallback: (info) => void fallbacks.push(info.reason),
			}),
		});

		expect(texts(result.segments)).toEqual([
			"webgpu-0",
			"wasm-416000",
			"wasm-832000",
		]);
		expect(result.segments.map((segment) => segment.start)).toEqual([
			0.5, 26.5, 52.5,
		]);

		// 旧 worker 已销毁；新 worker 用 CPU 加载并从出事的切片接着跑
		expect(fakeWorkers).toHaveLength(2);
		expect(fakeWorkers[0].terminated).toBe(true);
		expect(fakeWorkers[1].posted[0].message).toEqual({
			type: "init",
			modelId: MODEL,
			device: "wasm",
		});
		expect(transcribeMessageOf(fakeWorkers[1]).startFromSample).toBe(
			FAILED_SLICE,
		);

		expect(fallbacks).toEqual([reason]);
		expect(hasRecentGpuFailure()).toBe(true);
		expect(getDeviceDecision()).toMatchObject({
			device: "wasm",
			reason: "gpu-failed",
		});

		// 进度不回退：第一个切片已经报过 40%，续跑只在它之后
		const transcribing = progress
			.filter((update) => update.status === "transcribing")
			.map((update) => update.progress);
		expect(transcribing.slice(1).every((value) => value >= 40)).toBe(true);
	});

	test("GPU 推理挂住（promise 永不 settle）：切片超时后同样降级", async () => {
		let gpuCalls = 0;
		transformersMock.createPipeline = ({ device }) =>
			Promise.resolve(
				makePipeline({
					device,
					infer: ({ startSample }) => {
						if (device === "webgpu") {
							gpuCalls += 1;
							return hang();
						}
						return Promise.resolve(sliceOutput({ device, startSample }));
					},
				}),
			);

		const result = await withDeadline({
			promise: transcriptionService.transcribe({
				audioData: makeAudio(30),
				language: "en",
			}),
		});

		expect(gpuCalls).toBe(1);
		expect(texts(result.segments)).toEqual(["wasm-0", "wasm-416000"]);
		expect(fakeWorkers).toHaveLength(2);
		expect(fakeWorkers[0].terminated).toBe(true);
	});

	test("GPU worker 在推理中崩溃（只收到 onerror）：从当前切片续跑", async () => {
		transformersMock.createPipeline = ({ device }) =>
			Promise.resolve(
				makePipeline({
					device,
					infer: ({ startSample }) => {
						if (device === "webgpu" && startSample === FAILED_SLICE) {
							setTimeout(() => {
								fakeWorkers[0].crash(
									"Uncaught RuntimeError: table index is out of bounds",
								);
							}, 0);
							return hang();
						}
						return Promise.resolve(sliceOutput({ device, startSample }));
					},
				}),
			);

		const result = await transcribe70s();
		expect(texts(result.segments)).toEqual([
			"webgpu-0",
			"wasm-416000",
			"wasm-832000",
		]);
	});

	test("GPU worker 失联（不再有任何消息）：看门狗触发降级", async () => {
		// worker 侧的切片超时调大，确保是主线程看门狗先发现
		timeouts.webgpuSliceMs = 10_000;
		transformersMock.createPipeline = ({ device }) =>
			Promise.resolve(
				makePipeline({
					device,
					infer: ({ startSample }) =>
						device === "webgpu" && startSample === FAILED_SLICE
							? hang()
							: Promise.resolve(sliceOutput({ device, startSample })),
				}),
			);

		const result = await transcribe70s();
		expect(texts(result.segments)).toEqual([
			"webgpu-0",
			"wasm-416000",
			"wasm-832000",
		]);
		expect(hasRecentGpuFailure()).toBe(true);
	});
});

describe("GPU 在加载模型阶段失败", () => {
	beforeEach(reset);

	test("GPU 会话建不起来：换 CPU 加载后正常转写；不写失败记忆", async () => {
		const devices: string[] = [];
		transformersMock.createPipeline = ({ device }) => {
			devices.push(device);
			return device === "webgpu"
				? Promise.reject(new Error("webgpu session init failed"))
				: Promise.resolve(
						makePipeline({
							device,
							infer: ({ startSample }) =>
								Promise.resolve(sliceOutput({ device, startSample })),
						}),
					);
		};

		const result = await withDeadline({
			promise: transcriptionService.transcribe({
				audioData: makeAudio(10),
				language: "zh",
			}),
		});

		expect(devices).toEqual(["webgpu", "wasm"]);
		expect(texts(result.segments)).toEqual(["wasm-0"]);
		expect(fakeWorkers).toHaveLength(2);
		// 加载阶段的失败未必是 GPU 的锅，不因此给这台机器记上一笔
		expect(hasRecentGpuFailure()).toBe(false);
		expect(getDeviceDecision()).toMatchObject({
			device: "wasm",
			reason: "gpu-failed",
		});
	});

	test("GPU 建会话挂住（没有进度回调）：静默超时后降级", async () => {
		const devices: string[] = [];
		transformersMock.createPipeline = ({ device }) => {
			devices.push(device);
			return device === "webgpu"
				? hang()
				: Promise.resolve(
						makePipeline({
							device,
							infer: ({ startSample }) =>
								Promise.resolve(sliceOutput({ device, startSample })),
						}),
					);
		};

		const result = await withDeadline({
			promise: transcriptionService.transcribe({
				audioData: makeAudio(10),
				language: "zh",
			}),
		});

		expect(devices).toEqual(["webgpu", "wasm"]);
		expect(texts(result.segments)).toEqual(["wasm-0"]);
	});

	test("GPU 建会话期间下载慢但在走：不算挂起，不会被误杀", async () => {
		// 每 10ms 报一次进度，持续 100ms，远超 30ms 的静默阈值
		transformersMock.createPipeline = ({ device }) => {
			if (device !== "webgpu") {
				return Promise.resolve(
					makePipeline({
						device,
						infer: ({ startSample }) =>
							Promise.resolve(sliceOutput({ device, startSample })),
					}),
				);
			}
			return new Promise((resolve) => {
				const startedAt = Date.now();
				const tick = (): void => {
					if (Date.now() - startedAt < 100) {
						transformersMock.progress?.({
							status: "progress",
							file: "decoder_model_merged.q4.onnx",
							loaded: Date.now() - startedAt,
							total: 100,
						});
						setTimeout(tick, 10);
						return;
					}
					resolve(
						makePipeline({
							device,
							infer: ({ startSample }) =>
								Promise.resolve(sliceOutput({ device, startSample })),
						}),
					);
				};
				tick();
			});
		};

		const result = await withDeadline({
			promise: transcriptionService.transcribe({
				audioData: makeAudio(10),
				language: "zh",
			}),
		});

		// 全程用的都是那个 GPU worker，没有被静默超时误杀
		expect(texts(result.segments)).toEqual(["webgpu-0"]);
		expect(fakeWorkers).toHaveLength(1);
		expect(hasRecentGpuFailure()).toBe(false);
	});

	test("权重没下完就失败（网络问题）：直接报错，不换设备", async () => {
		transformersMock.createPipeline = () => {
			transformersMock.progress?.({
				status: "progress",
				file: "decoder_model_merged.q4.onnx",
				loaded: 10,
				total: 100,
			});
			return Promise.reject(new Error("Failed to fetch"));
		};

		const attempt = transcriptionService.transcribe({
			audioData: makeAudio(10),
			language: "zh",
		});
		await expect(withDeadline({ promise: attempt })).rejects.toThrow(
			"Failed to fetch",
		);
		expect(fakeWorkers).toHaveLength(1);
		expect(hasRecentGpuFailure()).toBe(false);
	});

	test("加载模型时取消：按取消处理，不触发降级", async () => {
		transformersMock.createPipeline = () => hang();

		const attempt = transcriptionService.transcribe({
			audioData: makeAudio(10),
			language: "zh",
		});
		await new Promise((resolve) => setTimeout(resolve, 20));
		transcriptionService.cancel();

		await expect(withDeadline({ promise: attempt })).rejects.toThrow(
			"Transcription cancelled",
		);
		expect(fakeWorkers).toHaveLength(1);
		expect(hasRecentGpuFailure()).toBe(false);
	});
});

describe("CPU 模式没有回退路径", () => {
	beforeEach(() => {
		reset();
		writeDevicePreference("cpu");
	});

	test("切片出错重试一次后成功", async () => {
		let attempts = 0;
		transformersMock.createPipeline = ({ device }) =>
			Promise.resolve(
				makePipeline({
					device,
					infer: ({ startSample }) => {
						const output = sliceOutput({ device, startSample });
						if (startSample === FAILED_SLICE && attempts === 0) {
							attempts += 1;
							return Promise.reject(new Error("transient decode error"));
						}
						return Promise.resolve(output);
					},
				}),
			);

		const result = await transcribe70s();
		expect(texts(result.segments)).toEqual([
			"wasm-0",
			"wasm-416000",
			"wasm-832000",
		]);
		expect(fakeWorkers).toHaveLength(1);
	});

	test("重试仍然失败：报错，不换设备", async () => {
		transformersMock.createPipeline = ({ device }) =>
			Promise.resolve(
				makePipeline({
					device,
					infer: ({ startSample }) =>
						startSample === FAILED_SLICE
							? Promise.reject(new Error("out of memory"))
							: Promise.resolve(sliceOutput({ device, startSample })),
				}),
			);

		await expect(transcribe70s()).rejects.toThrow("out of memory");
		expect(fakeWorkers).toHaveLength(1);
	});

	test("worker 失联：看门狗报错，不换设备", async () => {
		transformersMock.createPipeline = ({ device }) =>
			Promise.resolve(makePipeline({ device, infer: () => hang() }));

		await expect(transcribe70s()).rejects.toThrow(
			"Transcription stalled (no worker activity)",
		);
		expect(fakeWorkers).toHaveLength(1);
		expect(hasRecentGpuFailure()).toBe(false);
	});

	test("转写中取消：立即销毁 worker，不用等当前切片跑完", async () => {
		transformersMock.createPipeline = ({ device }) =>
			Promise.resolve(
				makePipeline({
					device,
					infer: () => {
						setTimeout(() => transcriptionService.cancel(), 0);
						return hang();
					},
				}),
			);

		await expect(transcribe70s()).rejects.toThrow("Transcription cancelled");
		expect(fakeWorkers).toHaveLength(1);
		expect(fakeWorkers[0].terminated).toBe(true);
	});
});

describe("设备策略与音频移交", () => {
	beforeEach(reset);

	test("GPU 模式主线程留底音频（不移交）；降级后交给 CPU worker 时才移交", async () => {
		transformersMock.createPipeline = ({ device }) =>
			Promise.resolve(
				makePipeline({
					device,
					infer: ({ startSample }) =>
						device === "webgpu"
							? Promise.reject(new Error("gpu boom"))
							: Promise.resolve(sliceOutput({ device, startSample })),
				}),
			);

		await withDeadline({
			promise: transcriptionService.transcribe({
				audioData: makeAudio(10),
				language: "zh",
			}),
		});

		expect(transcribeEntryOf(fakeWorkers[0]).transferCount).toBe(0);
		expect(transcribeEntryOf(fakeWorkers[1]).transferCount).toBe(1);
	});

	test("手动指定 CPU：从不创建 GPU worker", async () => {
		const devices: string[] = [];
		writeDevicePreference("cpu");
		transformersMock.createPipeline = ({ device }) => {
			devices.push(device);
			return Promise.resolve(
				makePipeline({
					device,
					infer: ({ startSample }) =>
						Promise.resolve(sliceOutput({ device, startSample })),
				}),
			);
		};

		await withDeadline({
			promise: transcriptionService.transcribe({
				audioData: makeAudio(10),
				language: "zh",
			}),
		});
		expect(devices).toEqual(["wasm"]);
		expect(transcribeEntryOf(fakeWorkers[0]).transferCount).toBe(1);
	});

	test("连续转写复用已加载的模型，不重建 worker", async () => {
		let creations = 0;
		transformersMock.createPipeline = ({ device }) => {
			creations += 1;
			return Promise.resolve(
				makePipeline({
					device,
					infer: ({ startSample }) =>
						Promise.resolve(sliceOutput({ device, startSample })),
				}),
			);
		};

		for (const language of ["zh", "en"] as const) {
			const result = await withDeadline({
				promise: transcriptionService.transcribe({
					audioData: makeAudio(5),
					language,
				}),
			});
			expect(texts(result.segments)).toEqual(["webgpu-0"]);
		}
		expect(creations).toBe(1);
		expect(fakeWorkers).toHaveLength(1);
	});
});
