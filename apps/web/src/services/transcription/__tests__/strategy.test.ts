import { beforeEach, describe, expect, test } from "bun:test";
import type {
	DeviceDecisionReason,
	GpuInfo,
	TranscriptionDevice,
} from "../strategy";
import {
	GPU_FAILURE_TTL_MS,
	announceDeviceDecision,
	classifyGpu,
	getDeviceDecision,
	hasRecentGpuFailure,
	readDevicePreference,
	refreshDeviceDecision,
	rememberGpuFailure,
	resolveTranscriptionDevice,
	subscribeDeviceDecision,
	writeDevicePreference,
} from "../strategy";
import { installMemoryStorage } from "./harness/memory-storage";

/**
 * 设备策略：独显走 GPU，核显 / 软件渲染 / 没有 WebGPU 走 CPU，认不出的先试
 * GPU 且失败后记住。分类依据是 Dawn 的 adapter.info，样例取自各平台 Chrome
 * 里实际上报的字符串。
 */

const storage = installMemoryStorage();

const ANGLE = ({ vendor, name }: { vendor: string; name: string }): string =>
	`ANGLE (${vendor[0]?.toUpperCase()}${vendor.slice(1)}, ${name} Direct3D11 vs_5_0 ps_5_0, D3D11)`;

function gpu(partial: Partial<GpuInfo>): GpuInfo {
	return {
		vendor: "",
		architecture: "",
		device: "",
		description: "",
		...partial,
	};
}

/** 装一个假的 navigator.gpu；adapterInfo 为 null 表示拿不到适配器。 */
function installFakeGpu(adapterInfo: GpuInfo | null): { requests: number } {
	const counter = { requests: 0 };
	Object.defineProperty(navigator, "gpu", {
		value: {
			requestAdapter: () => {
				counter.requests += 1;
				return Promise.resolve(
					adapterInfo === null ? null : { info: adapterInfo },
				);
			},
		},
		configurable: true,
	});
	return counter;
}

/** 把失败记忆的写入时间改掉，模拟「记了很久以前」。 */
function ageGpuFailure(ageMs: number): void {
	const raw = storage.get("mycut.transcription.gpu-failure");
	if (!raw) throw new Error("no gpu failure record to age");
	const record: unknown = JSON.parse(raw);
	if (typeof record !== "object" || record === null) {
		throw new Error("unexpected gpu failure record");
	}
	storage.set(
		"mycut.transcription.gpu-failure",
		JSON.stringify({ ...record, at: Date.now() - ageMs }),
	);
}

beforeEach(() => {
	storage.clear();
	installFakeGpu(null);
});

describe("显卡分类", () => {
	test("NVIDIA 与 Apple 芯片算独显", () => {
		expect(
			classifyGpu({
				gpu: gpu({
					vendor: "nvidia",
					architecture: "turing-2",
					description: ANGLE({
						vendor: "nvidia",
						name: "NVIDIA GeForce RTX 3060 (0x00002503)",
					}),
				}),
			}),
		).toBe("discrete");
		expect(
			classifyGpu({
				gpu: gpu({ vendor: "apple", architecture: "apple-gpu-g15c5" }),
			}),
		).toBe("discrete");
	});

	test("Intel：只有 Arc A 系列是独显", () => {
		const intel = (name: string): GpuInfo =>
			gpu({
				vendor: "intel",
				architecture: "gen-12lp",
				description: ANGLE({ vendor: "intel", name }),
			});
		expect(
			classifyGpu({ gpu: intel("Intel(R) UHD Graphics 630 (0x00003E9B)") }),
		).toBe("integrated");
		expect(
			classifyGpu({ gpu: intel("Intel(R) Iris(R) Xe Graphics (0x000046A6)") }),
		).toBe("integrated");
		// Core Ultra 上的 Arc 核显：名字里有 Arc，但没有 A + 三位数的型号
		expect(
			classifyGpu({ gpu: intel("Intel(R) Arc(TM) Graphics (0x00007D55)") }),
		).toBe("integrated");
		expect(
			classifyGpu({
				gpu: intel("Intel(R) Arc(TM) A770 Graphics (0x00005690)"),
			}),
		).toBe("discrete");
	});

	test("AMD：型号带 RX / Pro 才是独显，其余按核显处理", () => {
		const amd = (name: string): GpuInfo =>
			gpu({
				vendor: "amd",
				architecture: "rdna-3",
				description: ANGLE({ vendor: "amd", name }),
			});
		expect(classifyGpu({ gpu: amd("AMD Radeon(TM) Graphics") })).toBe(
			"integrated",
		);
		expect(classifyGpu({ gpu: amd("AMD Radeon 780M Graphics") })).toBe(
			"integrated",
		);
		expect(classifyGpu({ gpu: amd("AMD Radeon RX 7900 XTX") })).toBe(
			"discrete",
		);
		expect(classifyGpu({ gpu: amd("AMD Radeon Pro W7800") })).toBe("discrete");
		// 认不出的 AMD 型号宁可当核显：判错的代价只是慢，判成 GPU 则是转写失败
		expect(classifyGpu({ gpu: gpu({ vendor: "amd" }) })).toBe("integrated");
	});

	test("SoC 核显", () => {
		expect(
			classifyGpu({
				gpu: gpu({ vendor: "qualcomm", architecture: "adreno-740" }),
			}),
		).toBe("integrated");
		expect(
			classifyGpu({ gpu: gpu({ vendor: "arm", architecture: "mali-g710" }) }),
		).toBe("integrated");
	});

	test("软件渲染器", () => {
		expect(
			classifyGpu({
				gpu: gpu({
					vendor: "microsoft",
					description: ANGLE({
						vendor: "microsoft",
						name: "Microsoft Basic Render Driver",
					}),
				}),
			}),
		).toBe("software");
		expect(
			classifyGpu({
				gpu: gpu({
					vendor: "google",
					description:
						"ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)",
				}),
			}),
		).toBe("software");
	});

	test("认不出的 GPU 归为 unknown", () => {
		expect(classifyGpu({ gpu: gpu({}) })).toBe("unknown");
		expect(classifyGpu({ gpu: gpu({ vendor: "vmware" }) })).toBe("unknown");
	});
});

describe("按机器决定设备", () => {
	test("手动指定优先，且不去探测显卡", async () => {
		const counter = installFakeGpu(
			gpu({ vendor: "intel", description: "Intel(R) UHD Graphics 630" }),
		);

		writeDevicePreference("cpu");
		expect(await resolveTranscriptionDevice()).toEqual({
			device: "wasm",
			reason: "override",
			gpu: null,
		});

		writeDevicePreference("gpu");
		expect(await resolveTranscriptionDevice()).toEqual({
			device: "webgpu",
			reason: "override",
			gpu: null,
		});
		expect(counter.requests).toBe(0);
	});

	test("没有 WebGPU（或拿不到适配器）：CPU", async () => {
		installFakeGpu(null);
		expect(await resolveTranscriptionDevice()).toEqual({
			device: "wasm",
			reason: "no-webgpu",
			gpu: null,
		});
	});

	test("独显 → GPU；核显 / 软件渲染 → CPU；认不出 → 先试 GPU", async () => {
		const cases: Array<[GpuInfo, TranscriptionDevice, DeviceDecisionReason]> = [
			[
				gpu({ vendor: "nvidia", description: "NVIDIA GeForce RTX 4070" }),
				"webgpu",
				"discrete-gpu",
			],
			[
				gpu({ vendor: "intel", description: "Intel(R) UHD Graphics 630" }),
				"wasm",
				"integrated-gpu",
			],
			[
				gpu({ vendor: "amd", description: "AMD Radeon(TM) Graphics" }),
				"wasm",
				"integrated-gpu",
			],
			[gpu({ vendor: "microsoft" }), "wasm", "software-renderer"],
			[gpu({ vendor: "vmware" }), "webgpu", "unknown-gpu"],
		];
		for (const [info, device, reason] of cases) {
			installFakeGpu(info);
			const decision = await resolveTranscriptionDevice();
			expect([decision.device, decision.reason]).toEqual([device, reason]);
			expect(decision.gpu).toEqual(info);
		}
	});

	test("核显机器从一开始就不会去碰 GPU", async () => {
		// 这正是核显机器上转写失败的根源：GPU 推理在那类显卡上不稳定
		const counter = installFakeGpu(
			gpu({ vendor: "intel", description: "Intel(R) Iris(R) Xe Graphics" }),
		);
		const decision = await resolveTranscriptionDevice();
		expect(decision.device).toBe("wasm");
		// 探测本身只拿 adapter.info，不建会话、不推理
		expect(counter.requests).toBe(1);
	});
});

describe("GPU 失败记忆", () => {
	const discrete = gpu({
		vendor: "nvidia",
		description: "NVIDIA GeForce RTX 3060",
	});

	test("记过一次之后直接用 CPU，并带上当初的判定原因", async () => {
		installFakeGpu(discrete);
		expect((await resolveTranscriptionDevice()).device).toBe("webgpu");

		rememberGpuFailure();
		expect(hasRecentGpuFailure()).toBe(true);
		const decision = await resolveTranscriptionDevice();
		expect(decision.device).toBe("wasm");
		expect(decision.reason).toBe("remembered-failure");
		expect(decision.gpu).toEqual(discrete);
	});

	test("过了有效期就给 GPU 一次重新证明自己的机会", async () => {
		installFakeGpu(discrete);
		rememberGpuFailure();
		ageGpuFailure(GPU_FAILURE_TTL_MS + 1_000);
		expect(hasRecentGpuFailure()).toBe(false);
		expect((await resolveTranscriptionDevice()).device).toBe("webgpu");
	});

	test("浏览器大版本变了（引擎随之更新）：记忆作废", () => {
		rememberGpuFailure();
		storage.set(
			"mycut.transcription.gpu-failure",
			JSON.stringify({ at: Date.now(), browser: "chrome-999" }),
		);
		expect(hasRecentGpuFailure()).toBe(false);
	});

	test("存储里的内容坏了不影响判定", () => {
		storage.set("mycut.transcription.gpu-failure", "not json");
		expect(hasRecentGpuFailure()).toBe(false);
		storage.set("mycut.transcription.gpu-failure", JSON.stringify([1, 2]));
		expect(hasRecentGpuFailure()).toBe(false);
	});

	test("手动改选择是一次明确的「重新来」：清掉失败记忆", async () => {
		installFakeGpu(discrete);
		rememberGpuFailure();
		expect((await resolveTranscriptionDevice()).device).toBe("wasm");

		writeDevicePreference("cpu");
		expect(hasRecentGpuFailure()).toBe(false);
		writeDevicePreference("auto");
		expect(readDevicePreference()).toBe("auto");
		expect((await resolveTranscriptionDevice()).device).toBe("webgpu");
	});

	test("没有可用的 localStorage：读不到记忆，也不抛错", () => {
		Object.defineProperty(globalThis, "localStorage", {
			value: {
				getItem: () => {
					throw new Error("SecurityError");
				},
				setItem: () => {
					throw new Error("SecurityError");
				},
				removeItem: () => {
					throw new Error("SecurityError");
				},
			},
			configurable: true,
		});
		expect(() => rememberGpuFailure()).not.toThrow();
		expect(hasRecentGpuFailure()).toBe(false);
		expect(readDevicePreference()).toBe("auto");
		installMemoryStorage();
	});
});

describe("判定结果的发布", () => {
	test("refresh 重新判定并通知订阅者；并发调用合并成一次探测", async () => {
		const listenersNotified: number[] = [];
		const unsubscribe = subscribeDeviceDecision((decision) => {
			listenersNotified.push(decision.device === "webgpu" ? 1 : 0);
		});

		const counter = installFakeGpu(
			gpu({ vendor: "nvidia", description: "NVIDIA GeForce RTX 3060" }),
		);
		const [first, second] = await Promise.all([
			refreshDeviceDecision(),
			refreshDeviceDecision(),
		]);
		expect(first).toBe(second);
		expect(getDeviceDecision()).toBe(first);
		expect(counter.requests).toBe(1);

		// 运行期降级：service 直接发布 CPU 的判定，界面据此更新
		announceDeviceDecision({ device: "wasm", reason: "gpu-failed", gpu: null });
		expect(getDeviceDecision()?.reason).toBe("gpu-failed");

		unsubscribe();
		announceDeviceDecision({ device: "webgpu", reason: "override", gpu: null });
		expect(listenersNotified).toEqual([1, 0]);
	});
});
