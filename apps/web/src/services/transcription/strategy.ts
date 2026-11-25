/**
 * 转写设备策略：按机器决定字幕转写走 GPU 还是 CPU。
 *
 * ONNX Runtime 的 WebGPU 推理在核显上不可靠：会话建得起来，但一推理就失败
 * （"table index is out of bounds"、GPUBuffer 回读失败……随版本表现不同），
 * 属于驱动层面的问题，升级依赖解决不了；独显上则又快又稳。所以既不能全量
 * 走 WebGPU，也不该一刀切全走 CPU：
 *   - 独显 / Apple 芯片 → GPU（快），带运行期兜底；
 *   - 核显 / 软件渲染 / 没有 WebGPU → CPU（wasm），从一开始就不去碰 GPU；
 *   - 认不出的 GPU → 先试 GPU，失败一次就记住这台机器，一段时间内直接 CPU。
 * 用户可以在字幕面板手动指定（DevicePreference），手动指定优先于自动判定。
 */

export type TranscriptionDevice = "webgpu" | "wasm";

export type TranscriptionDevicePreference = "auto" | "gpu" | "cpu";

export type GpuClass = "discrete" | "integrated" | "software" | "unknown";

export type DeviceDecisionReason =
	| "override"
	| "no-webgpu"
	| "remembered-failure"
	| "software-renderer"
	| "integrated-gpu"
	| "discrete-gpu"
	| "unknown-gpu"
	/** 本次页面会话里 GPU 运行期失败，已改用 CPU。 */
	| "gpu-failed";

export interface GpuInfo {
	vendor: string;
	architecture: string;
	device: string;
	description: string;
}

export interface DeviceDecision {
	device: TranscriptionDevice;
	/** 判定依据；写日志、界面提示用。 */
	reason: DeviceDecisionReason;
	/** 探测到的显卡；没有 GPU 或手动指定时不探测，为 null。 */
	gpu: GpuInfo | null;
}

const PREFERENCE_KEY = "mycut.transcription.device";
const GPU_FAILURE_KEY = "mycut.transcription.gpu-failure";

/** 失败记忆的有效期：驱动或浏览器更新后 GPU 应当有机会重新证明自己。 */
export const GPU_FAILURE_TTL_MS = 30 * 24 * 60 * 60_000;

/** SoC 里的核显（笔记本 / 平板 / 手机芯片）。 */
const SOC_GPU_VENDORS: ReadonlySet<string> = new Set([
	"qualcomm",
	"arm",
	"samsung",
	"imagination",
	"broadcom",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/**
 * 按显卡标识分类。依据是 Dawn 的 adapter.info（vendor 为小写厂商名，
 * description 为 ANGLE 的渲染器字符串，如 "ANGLE (Intel, Intel(R) UHD
 * Graphics 630 (0x00003E9B) Direct3D11 …)"）。判不准的一律往「核显」靠——
 * 误判成 CPU 只是慢，误判成 GPU 则是转写失败。
 */
export function classifyGpu({ gpu }: { gpu: GpuInfo }): GpuClass {
	const text =
		`${gpu.vendor} ${gpu.architecture} ${gpu.description}`.toLowerCase();

	// SwiftShader / WARP / llvmpipe 是 CPU 模拟出来的 GPU：走 WebGPU 只会比原生 wasm 更慢
	if (
		gpu.vendor === "microsoft" ||
		/swiftshader|llvmpipe|softpipe|basic render/.test(text)
	) {
		return "software";
	}

	// NVIDIA 的桌面 / 笔记本显卡基本都是独显；Apple 芯片的 GPU 配合统一内存，WebGPU 稳定且快
	if (gpu.vendor === "nvidia" || gpu.vendor === "apple") {
		return "discrete";
	}

	// Intel 的独显只有 Arc A 系列（A380 / A750 / A770…）；UHD / Iris / Xe 以及
	// Core Ultra 上的 Arc 核显都算核显
	if (gpu.vendor === "intel") {
		return /\barc.*\ba\d{3}\b/.test(text) ? "discrete" : "integrated";
	}

	// AMD 独显型号带 RX / Pro（Radeon RX 7900、Radeon Pro W7800）；核显是
	// Radeon Graphics / 610M~890M / Vega。拿不准的同样按核显处理
	if (gpu.vendor === "amd") {
		return /\bradeon\b.*\b(rx|pro)\b/.test(text) ? "discrete" : "integrated";
	}

	if (SOC_GPU_VENDORS.has(gpu.vendor)) {
		return "integrated";
	}

	return "unknown";
}

function isObject(value: unknown): value is object {
	return typeof value === "object" && value !== null;
}

/**
 * 探测显卡。返回 null 表示没有可用的 WebGPU 适配器。
 *
 * apps/web 用的 TS lib.dom（5.9）里没有 WebGPU 类型，所以按结构用 Reflect
 * 读，不引用 GPU 相关类型；不传 powerPreference——Windows 上的 Chrome 会
 * 忽略它，并且每次都打一条警告。
 */
export async function probeGpu(): Promise<GpuInfo | null> {
	if (typeof navigator === "undefined") return null;

	const gpu: unknown = Reflect.get(navigator, "gpu");
	if (!isObject(gpu)) return null;
	const requestAdapter: unknown = Reflect.get(gpu, "requestAdapter");
	if (typeof requestAdapter !== "function") return null;

	try {
		const adapter: unknown = await Reflect.apply(requestAdapter, gpu, []);
		if (!isObject(adapter)) return null;

		const info: unknown = Reflect.get(adapter, "info");
		if (!isObject(info)) return null;

		// 逐个读而不是 Object.entries：GPUAdapterInfo 的字段是原型上的 getter，
		// 不是自有可枚举属性，entries 会全部拿到 undefined（实测 NVIDIA 机器
		// 上 vendor 明明有值，判定却退化成 unknown）。
		const read = (key: keyof GpuInfo): string => {
			const value: unknown = Reflect.get(info, key);
			return typeof value === "string" ? value : "";
		};
		return {
			vendor: read("vendor"),
			architecture: read("architecture"),
			device: read("device"),
			description: read("description"),
		};
	} catch {
		return null;
	}
}

function readStorage(key: string): string | null {
	try {
		return globalThis.localStorage?.getItem(key) ?? null;
	} catch {
		// 隐私模式下访问 localStorage 会抛；没有存储就当没有记忆
		return null;
	}
}

function writeStorage({
	key,
	value,
}: {
	key: string;
	value: string | null;
}): void {
	try {
		if (value === null) {
			globalThis.localStorage?.removeItem(key);
		} else {
			globalThis.localStorage?.setItem(key, value);
		}
	} catch {
		// 存不进去只是下次还得再试一次 GPU，不影响本次转写
	}
}

/** 浏览器大版本：引擎（含 Dawn / ANGLE）随它更新，变了就该让 GPU 重试。 */
function browserToken(): string {
	if (typeof navigator === "undefined") return "unknown";
	const match = /Chrome\/(\d+)/.exec(navigator.userAgent);
	return match?.[1] ? `chrome-${match[1]}` : navigator.userAgent.slice(0, 120);
}

export function readDevicePreference(): TranscriptionDevicePreference {
	const value = readStorage(PREFERENCE_KEY);
	return value === "gpu" || value === "cpu" ? value : "auto";
}

/** 手动选择是一次的明确的「重新来」：顺手清掉失败记忆，回到 auto 时重新判定。 */
export function writeDevicePreference(
	preference: TranscriptionDevicePreference,
): void {
	writeStorage({ key: PREFERENCE_KEY, value: preference });
	writeStorage({ key: GPU_FAILURE_KEY, value: null });
}

export function hasRecentGpuFailure(): boolean {
	const raw = readStorage(GPU_FAILURE_KEY);
	if (!raw) return false;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!isRecord(parsed)) return false;
		const at = typeof parsed.at === "number" ? parsed.at : Number.NaN;
		const browser = typeof parsed.browser === "string" ? parsed.browser : "";
		if (browser !== browserToken()) return false;
		return Date.now() - at < GPU_FAILURE_TTL_MS;
	} catch {
		return false;
	}
}

export function rememberGpuFailure(): void {
	writeStorage({
		key: GPU_FAILURE_KEY,
		value: JSON.stringify({ at: Date.now(), browser: browserToken() }),
	});
}

/** 自动判定当前机器该用的设备；手动指定优先。 */
export async function resolveTranscriptionDevice(): Promise<DeviceDecision> {
	const preference = readDevicePreference();
	if (preference === "cpu") {
		return { device: "wasm", reason: "override", gpu: null };
	}
	if (preference === "gpu") {
		return { device: "webgpu", reason: "override", gpu: null };
	}

	const gpu = await probeGpu();
	if (!gpu) return { device: "wasm", reason: "no-webgpu", gpu: null };
	if (hasRecentGpuFailure()) {
		return { device: "wasm", reason: "remembered-failure", gpu };
	}

	switch (classifyGpu({ gpu })) {
		case "discrete":
			return { device: "webgpu", reason: "discrete-gpu", gpu };
		case "integrated":
			return { device: "wasm", reason: "integrated-gpu", gpu };
		case "software":
			return { device: "wasm", reason: "software-renderer", gpu };
		default:
			// 认不出的 GPU 先给一次机会：运行期失败会由 service 记下来
			return { device: "webgpu", reason: "unknown-gpu", gpu };
	}
}

// 最近一次判定结果：字幕面板据此显示「本机使用 GPU / CPU」及原因。
type DecisionListener = (decision: DeviceDecision) => void;
const listeners = new Set<DecisionListener>();
let currentDecision: DeviceDecision | null = null;
let pendingRefresh: Promise<DeviceDecision> | null = null;

export function getDeviceDecision(): DeviceDecision | null {
	return currentDecision;
}

export function subscribeDeviceDecision(
	listener: DecisionListener,
): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** service 在运行期改用 CPU 时发布，界面同步更新。 */
export function announceDeviceDecision(decision: DeviceDecision): void {
	currentDecision = decision;
	for (const listener of listeners) listener(decision);
}

/**
 * 重新判定当前机器的设备：字幕面板挂载、用户改了手动选择、需要新建 worker
 * 时调用。并发调用合并成一次探测，但每次都会重新读存储（偏好 / 失败记忆）。
 */
export function refreshDeviceDecision(): Promise<DeviceDecision> {
	if (!pendingRefresh) {
		pendingRefresh = resolveTranscriptionDevice()
			.then((decision) => {
				announceDeviceDecision(decision);
				return decision;
			})
			.finally(() => {
				pendingRefresh = null;
			});
	}
	return pendingRefresh;
}
