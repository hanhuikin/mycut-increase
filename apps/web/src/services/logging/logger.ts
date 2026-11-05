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

const IS_BROWSER = typeof window !== "undefined";

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

function readContextFields(): Record<string, unknown> {
	return globalBridge.__mycutLogContext?.() ?? {};
}

function clientTraceId(): string | undefined {
	if (!IS_BROWSER) return undefined;
	return window.__TRACE_ID__;
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
function emit(
	level: LogLevel,
	msg: string,
	fields?: Record<string, unknown>,
): void {
	if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[minLevel()]) return;
	const context = readContextFields();
	const record: Record<string, unknown> = {
		timestamp: new Date().toISOString(),
		level,
		service: SERVICE,
		env: appEnv(),
		trace_id: (context.trace_id as string | undefined) ?? clientTraceId(),
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
	try {
		channel[level](JSON.stringify(record));
	} catch {
		// Cyclic field or Hostile toJSON: still emit the essential line.
		channel[level](
			JSON.stringify({
				timestamp: new Date().toISOString(),
				level,
				service: SERVICE,
				env: appEnv(),
				msg,
			}),
		);
	}
}

export const logger = {
	debug: (msg: string, fields?: Record<string, unknown>) =>
		emit("DEBUG", msg, fields),
	info: (msg: string, fields?: Record<string, unknown>) =>
		emit("INFO", msg, fields),
	warn: (msg: string, fields?: Record<string, unknown>) =>
		emit("WARN", msg, fields),
	error: (msg: string, fields?: Record<string, unknown>) =>
		emit("ERROR", msg, fields),
};
