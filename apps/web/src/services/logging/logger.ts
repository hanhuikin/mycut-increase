/**
 * The one log format the whole app speaks: a single JSON object per line,
 * shaped like the ops access-log sample (timestamp/level/service/env/trace_id,
 * plus the nginx-style request fields when a request context exists). One
 * line per event keeps `docker logs` / `kubectl logs` / Loki ingesting it
 * without a parser.
 *
 * 本地开发、test、prod 都输出：DEBUG/INFO 在 dev 全量打开，test/prod 默认
 * INFO，用 LOG_LEVEL（服务端）或 NEXT_PUBLIC_DEBUG_FRAMES（客户端取帧埋点）
 * 调节。
 *
 * Why bound references below: the production build strips literal
 * `console.*` call sites across the whole bundle (`compiler.removeConsole`),
 * which would otherwise swallow the app's own logs too — node_modules included
 * (better-auth's default output is console.*). The logger is the sanctioned
 * channel that must survive the strip, so it calls references captured once
 * here that the transform cannot statically match.
 */

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
	DEBUG: 10,
	INFO: 20,
	WARN: 30,
	ERROR: 40,
};

const SERVICE = "mycut-web";

/**
 * 浏览器判定不能用 `typeof window`：打包器会在 client chunk 里把它静态折叠
 * 成真值，而 Web Worker 的 chunk 同样算 client chunk —— 折叠后 worker 里访问
 * window.__TRACE_ID__ 会抛 "window is not defined"，把真正要记录的错误掩盖掉
 * （字幕转写 worker 的初始化失败就这么丢了原因）。Reflect 读取不会被折叠。
 */
const IS_BROWSER = typeof Reflect.get(globalThis, "window") === "object";

function minLevel(): LogLevel {
	// The frame-picker performance instrumentation (NEXT_PUBLIC_DEBUG_FRAMES)
	// doubles as a client DEBUG switch so it works in a production build.
	if (IS_BROWSER && process.env.NEXT_PUBLIC_DEBUG_FRAMES === "1") {
		return "DEBUG";
	}
	const configured = (process.env.LOG_LEVEL ?? "").trim().toUpperCase();
	if (configured in LEVEL_WEIGHT) return configured as LogLevel;
	return process.env.NODE_ENV === "production" ? "INFO" : "DEBUG";
}

function appEnv(): string {
	const configured = (process.env.APP_ENV ?? "").trim();
	if (configured) return configured;
	return process.env.NODE_ENV === "production" ? "prod" : "dev";
}

/**
 * Request context arrives through this indirection because the logger is
 * isomorphic: the ALS store lives in request-context.ts (node:async_hooks,
 * server-only) and registers itself here without pulling Node builtins into
 * the client bundle.
 */
type ContextSource = () => Record<string, unknown> | undefined;
const globalBridge = globalThis as { __mycutLogContext?: ContextSource };

/**
 * 非浏览器线程（Web Worker）用这个注册自己的上下文：worker 拿不到
 * window.__TRACE_ID__，由主线程在 init 消息里把 trace id 传进来，日志才能
 * 和同一次会话对上。
 */
export function registerLogContext(source: ContextSource): void {
	globalBridge.__mycutLogContext = source;
}

function readContextFields(): Record<string, unknown> {
	return globalBridge.__mycutLogContext?.() ?? {};
}

/** 当前会话的 trace id；worker / 服务端没有 window，返回 undefined。 */
export function currentClientTraceId(): string | undefined {
	const browserWindow: unknown = Reflect.get(globalThis, "window");
	if (typeof browserWindow !== "object" || browserWindow === null) {
		return undefined;
	}
	const traceId: unknown = Reflect.get(browserWindow, "__TRACE_ID__");
	return typeof traceId === "string" ? traceId : undefined;
}

const REDACT_KEY_RE = /passw|secret|token|authorization|cookie|credential/i;

/** Field-level redaction, three levels deep — call sites stay careless. */
function sanitize(value: unknown, depth = 0): unknown {
	if (value === null || value === undefined) return undefined;
	if (value instanceof Error) {
		return { name: value.name, message: value.message, stack: value.stack };
	}
	if (typeof value !== "object") return value;
	if (Array.isArray(value)) {
		return depth >= 3 ? "[…]" : value.map((item) => sanitize(item, depth + 1));
	}
	const record: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		record[key] = REDACT_KEY_RE.test(key)
			? "[redacted]"
			: sanitize(item, depth + 1);
	}
	return record;
}

const channel: Record<LogLevel, (...args: unknown[]) => void> = {
	DEBUG: console.log.bind(console),
	INFO: console.log.bind(console),
	WARN: console.warn.bind(console),
	ERROR: console.error.bind(console),
};

/**
 * Field order mirrors the ops sample: identity, then request context, then
 * `msg`, then the event's own fields. `undefined`/empty fields are omitted so
 * non-request events carry no request clutter.
 */
function emit({
	level,
	msg,
	fields,
}: {
	level: LogLevel;
	msg: string;
	fields?: Record<string, unknown>;
}): void {
	if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel()]) return;
	// 记日志永远不能让调用方失败：worker 里曾因为上下文读取抛错，把正在
	// 上报的初始化失败整个吞掉，界面只剩一个没有原因的失败。
	try {
		emitRecord({ level, msg, fields });
	} catch {
		try {
			channel[level](
				JSON.stringify({
					timestamp: new Date().toISOString(),
					level,
					service: SERVICE,
					env: appEnv(),
					msg,
				}),
			);
		} catch {
			// 连降级输出都失败就只能放弃：日志不是业务路径
		}
	}
}

function emitRecord({
	level,
	msg,
	fields,
}: {
	level: LogLevel;
	msg: string;
	fields?: Record<string, unknown>;
}): void {
	const context = readContextFields();
	const record: Record<string, unknown> = {
		timestamp: new Date().toISOString(),
		level,
		service: SERVICE,
		env: appEnv(),
		trace_id:
			(context.trace_id as string | undefined) ?? currentClientTraceId(),
	};
	const requestKeys = [
		"remote_addr",
		"user_id",
		"session_id",
		"request_method",
		"request_uri",
		"status",
		"body_bytes_sent",
		"http_referer",
		"http_user_agent",
		"latency_ms",
		"upstream_response_time",
		"host",
	] as const;
	for (const key of requestKeys) {
		const value = context[key];
		if (value !== undefined && value !== null && value !== "") {
			record[key] = value;
		}
	}
	record.msg = msg;
	if (fields) {
		for (const [key, value] of Object.entries(fields)) {
			const sanitized = sanitize(value);
			if (sanitized !== undefined) record[key] = sanitized;
		}
	}
	channel[level](JSON.stringify(record));
}

export const logger = {
	debug: (msg: string, fields?: Record<string, unknown>) =>
		emit({ level: "DEBUG", msg, fields }),
	info: (msg: string, fields?: Record<string, unknown>) =>
		emit({ level: "INFO", msg, fields }),
	warn: (msg: string, fields?: Record<string, unknown>) =>
		emit({ level: "WARN", msg, fields }),
	error: (msg: string, fields?: Record<string, unknown>) =>
		emit({ level: "ERROR", msg, fields }),
};
