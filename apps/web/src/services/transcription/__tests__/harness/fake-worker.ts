import type {
	TranscriptionWorkerHandlers,
	TranscriptionWorkerScope,
	WorkerMessage,
	WorkerResponse,
} from "../../worker";

/**
 * 进程内的假 Web Worker：service.ts 里 `new Worker(new URL("./worker.ts"))`
 * 得到的是它。每个假 worker 用工厂 createTranscriptionWorker 给自己建一份
 * 转写逻辑（状态互不干扰），跑在下面这个假的 worker 作用域上。消息投递和
 * 真实 postMessage 一样是异步的；已销毁的 worker 不再收发消息。
 */

export interface WorkerModule {
	createTranscriptionWorker: (
		scope: TranscriptionWorkerScope,
	) => TranscriptionWorkerHandlers;
}

/**
 * 加载 worker 模块。由测试传入而不是在这里静态 import：worker 模块要在
 * transformers 替身装好之后才第一次加载。
 */
export type WorkerModuleLoader = () => Promise<WorkerModule>;

export interface FakeWorkerScope extends TranscriptionWorkerScope {
	onmessage: TranscriptionWorkerHandlers["onmessage"] | null;
	onerror: TranscriptionWorkerHandlers["onerror"] | null;
}

export interface PostedMessage {
	message: WorkerMessage;
	transferCount: number;
}

type MessageListener = (event: { data: WorkerResponse }) => void;

let loadWorkerModule: WorkerModuleLoader = () =>
	Promise.reject(
		new Error(
			"fake worker: call installFakeWorkerGlobal() before creating workers",
		),
	);

let instanceCounter = 0;
export const fakeWorkers: FakeWorker[] = [];

export function resetFakeWorkers(): void {
	fakeWorkers.length = 0;
}

export function installFakeWorkerGlobal(loader: WorkerModuleLoader): void {
	loadWorkerModule = loader;
	Object.defineProperty(globalThis, "Worker", {
		value: FakeWorker,
		configurable: true,
		writable: true,
	});
}

export class FakeWorker {
	readonly instance: number;
	readonly scope: FakeWorkerScope;
	readonly posted: PostedMessage[] = [];
	terminated = false;
	onerror: ((event: { message: string }) => void) | null = null;

	private readonly listeners = new Set<MessageListener>();
	private readonly inbox: WorkerMessage[] = [];
	private ready = false;
	private loadError: string | null = null;

	constructor(url: URL) {
		this.instance = ++instanceCounter;
		fakeWorkers.push(this);
		this.scope = {
			location: { origin: "http://localhost" },
			onmessage: null,
			onerror: null,
			postMessage: (response) => this.deliver(response),
		};

		void loadWorkerModule().then(
			(module) => {
				const handlers = module.createTranscriptionWorker(this.scope);
				this.scope.onmessage = handlers.onmessage;
				this.scope.onerror = handlers.onerror;
				this.ready = true;
				this.flush();
			},
			(error: unknown) => {
				this.loadError = `fake worker: failed to load ${url.href}: ${String(error)}`;
				this.ready = true;
				this.flush();
			},
		);
	}

	/* eslint-disable opencut/prefer-object-params -- 1:1 照搬 Web Worker API：签名由调用方（service.ts 与 DOM 规范）约定，不是本项目自己设计的接口。 */
	postMessage(message: WorkerMessage, transfer?: Transferable[]): void {
		if (this.terminated) return;
		this.posted.push({
			message: { ...message },
			transferCount: transfer?.length ?? 0,
		});
		this.inbox.push(message);
		this.flush();
	}

	terminate(): void {
		this.terminated = true;
	}

	addEventListener(type: string, listener: MessageListener): void {
		if (type === "message") this.listeners.add(listener);
	}

	removeEventListener(type: string, listener: MessageListener): void {
		if (type === "message") this.listeners.delete(listener);
	}
	/* eslint-enable opencut/prefer-object-params */

	/** 模拟 worker 里未捕获的异常 / OOM：主线程只会收到 onerror。 */
	crash(message: string): void {
		if (this.terminated) return;
		this.onerror?.({ message });
	}

	private flush(): void {
		if (!this.ready) return;
		if (this.loadError !== null) {
			const message = this.loadError;
			this.loadError = null;
			this.onerror?.({ message });
			return;
		}
		for (const message of this.inbox.splice(0)) {
			setTimeout(() => {
				if (this.terminated) return;
				this.scope.onmessage?.({ data: message });
			}, 0);
		}
	}

	private deliver(response: WorkerResponse): void {
		setTimeout(() => {
			if (this.terminated) return;
			for (const listener of [...this.listeners]) listener({ data: response });
		}, 0);
	}
}
