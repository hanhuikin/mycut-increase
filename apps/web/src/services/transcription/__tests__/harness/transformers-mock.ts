/**
 * @huggingface/transformers 的替身，只实现 worker.ts 用到的 env / pipeline。
 * 行为由各测试通过 transformersMock.createPipeline 注入（抛错、挂起、按切片
 * 返回不同结果），用来给降级链路做故障注入。
 */

export interface ProgressInfo {
	status?: string;
	file?: string;
	loaded?: number;
	total?: number;
}

export interface FakeInferenceInput {
	device: "webgpu" | "wasm";
	/** 本切片在整段音频里的起点（采样点）。 */
	startSample: number;
	audio: Float32Array;
}

export interface FakeOutput {
	text: string;
	chunks: Array<{ text: string; timestamp: [number, number] }>;
}

export type FakeInfer = (input: FakeInferenceInput) => Promise<FakeOutput>;

/** worker 把 pipeline 当函数调用（transcriber(slice, options)），替身也得可调用。 */
export type FakePipeline = ((audio: Float32Array) => Promise<FakeOutput>) & {
	dispose: () => Promise<void>;
};

export type CreatePipeline = (options: {
	modelId: string;
	device: "webgpu" | "wasm";
}) => Promise<FakePipeline>;

const idleOutput: FakeOutput = { text: "", chunks: [] };
const idleCreate: CreatePipeline = () =>
	Promise.resolve(
		makePipeline({
			device: "wasm",
			infer: () => Promise.resolve(idleOutput),
		}),
	);

export const transformersMock: {
	env: {
		remoteHost: string;
		remotePathTemplate: string;
		allowLocalModels: boolean;
		backends: Record<string, never>;
	};
	createPipeline: CreatePipeline;
	/** 最近一次 pipeline() 拿到的进度回调；测试用它模拟下载进度。 */
	progress: ((info: ProgressInfo) => void) | null;
} = {
	env: {
		remoteHost: "",
		remotePathTemplate: "",
		allowLocalModels: false,
		backends: {},
	},
	createPipeline: idleCreate,
	progress: null,
};

export const idleCreatePipeline = idleCreate;

/* eslint-disable opencut/prefer-object-params -- 与 transformers.js 的 pipeline() 签名保持一致 */
export function pipelineMock(
	_task: string,
	modelId: string,
	options: {
		device: "webgpu" | "wasm";
		progress_callback?: (info: ProgressInfo) => void;
	},
): Promise<FakePipeline> {
	transformersMock.progress = options.progress_callback ?? null;
	return transformersMock.createPipeline({ modelId, device: options.device });
}
/* eslint-enable opencut/prefer-object-params */

/** 一条落在切片辖区中部的字幕：文本带上设备和切片起点，断言续跑结果时一眼可辨。 */
export function sliceOutput({
	device,
	startSample,
}: {
	device: string;
	startSample: number;
}): FakeOutput {
	const label = `${device}-${startSample}`;
	return { text: label, chunks: [{ text: label, timestamp: [0.5, 1.5] }] };
}

export function makePipeline({
	device,
	infer,
}: {
	device: "webgpu" | "wasm";
	infer: FakeInfer;
}): FakePipeline {
	const call = (audio: Float32Array): Promise<FakeOutput> =>
		// worker 传进来的是整段音频的 subarray 视图，byteOffset 就是切片起点
		infer({
			device,
			audio,
			startSample: audio.byteOffset / Float32Array.BYTES_PER_ELEMENT,
		});
	return Object.assign(call, { dispose: () => Promise.resolve() });
}

/** 永不 settle：模拟推理挂住（事件循环仍存活，看门狗 / 超时才会触发）。 */
export function hang(): Promise<never> {
	return new Promise<never>(() => {});
}
