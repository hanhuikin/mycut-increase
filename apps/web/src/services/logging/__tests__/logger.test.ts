import { afterAll, describe, expect, test } from "bun:test";

/**
 * 日志层不能让调用方失败。曾经在字幕转写 worker 里出过事：打包器把
 * `typeof window` 折叠成真值，worker 里访问 window.__TRACE_ID__ 抛
 * "window is not defined"，恰好发生在 handleInit 上报初始化失败的 logger.error
 * 里，把真正的原因整个吞掉，界面只剩一句「字幕生成失败」。
 *
 * logger 在模块加载时就把 console 方法绑定进 channel 表，所以必须在导入它
 * 之前替换 console，否则抓不到输出。
 */

const captured: Array<{ level: string; line: string }> = [];
const originals = {
	log: console.log,
	warn: console.warn,
	error: console.error,
};

console.log = (...args: unknown[]) => {
	captured.push({ level: "log", line: args.map(String).join(" ") });
};
console.warn = (...args: unknown[]) => {
	captured.push({ level: "warn", line: args.map(String).join(" ") });
};
console.error = (...args: unknown[]) => {
	captured.push({ level: "error", line: args.map(String).join(" ") });
};

const { currentClientTraceId, logger, registerLogContext } =
	await import("../logger");

afterAll(() => {
	console.log = originals.log;
	console.warn = originals.warn;
	console.error = originals.error;
});

function lastRecord(): Record<string, unknown> {
	const entry = captured.at(-1);
	if (!entry) throw new Error("nothing was logged");
	const parsed: unknown = JSON.parse(entry.line);
	if (typeof parsed !== "object" || parsed === null) {
		throw new Error("log line is not a JSON object");
	}
	return Object.fromEntries(Object.entries(parsed));
}

describe("logger 在没有 window 的线程里", () => {
	test("没有 window 时 trace id 为空，且日志照常输出、不抛错", () => {
		expect(Reflect.get(globalThis, "window")).toBeUndefined();
		expect(currentClientTraceId()).toBeUndefined();

		captured.length = 0;
		expect(() =>
			logger.error("transcription model init failed", {
				device: "webgpu",
				error: "Failed to fetch",
			}),
		).not.toThrow();

		expect(captured).toHaveLength(1);
		const record = lastRecord();
		expect(record).toMatchObject({
			level: "ERROR",
			msg: "transcription model init failed",
			device: "webgpu",
			error: "Failed to fetch",
		});
		// 没有会话上下文就不该写 trace_id 字段
		expect(record).not.toHaveProperty("trace_id");
	});

	test("worker 注册上下文后，日志带上主线程传进来的 trace id", () => {
		registerLogContext(() => ({ trace_id: "trace-abc123" }));

		captured.length = 0;
		logger.info("transcription model ready", { device: "wasm" });

		expect(captured).toHaveLength(1);
		expect(lastRecord()).toMatchObject({
			level: "INFO",
			msg: "transcription model ready",
			trace_id: "trace-abc123",
		});
	});

	test("上下文读取抛错时依然产出一行日志（降到最小字段）", () => {
		registerLogContext(() => {
			throw new Error("context exploded");
		});

		captured.length = 0;
		expect(() => logger.error("still alive")).not.toThrow();

		expect(captured).toHaveLength(1);
		expect(lastRecord()).toMatchObject({ level: "ERROR", msg: "still alive" });
	});
});
