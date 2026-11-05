import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-request log context, carried through every await on the request's
 * stack via AsyncLocalStorage, so any log line emitted while handling a
 * request (route handlers, better-auth, guards) carries the same trace_id
 * and the nginx-style request fields — without threading a logger argument
 * through every call.
 *
 * Server-only (node:async_hooks). The isomorphic logger reads the store
 * through the `globalThis` bridge registered below instead of importing
 * this module, keeping Node builtins out of the client bundle.
 */
export interface RequestLogContext {
	traceId: string;
	method: string;
	uri: string;
	host: string;
	remoteAddr: string;
	userAgent: string;
	referer: string;
	startMs: number;
	status?: number;
	bodyBytes?: number;
	latencyMs?: number;
	userId?: string;
	sessionId?: string;
}

const storage = new AsyncLocalStorage<RequestLogContext>();

export function runWithRequestContext<T>(
	context: RequestLogContext,
	fn: () => Promise<T>,
): Promise<T> {
	return storage.run(context, fn);
}

export function getRequestLogContext(): RequestLogContext | undefined {
	return storage.getStore();
}

/**
 * Enriches the current request's access line with the acting user. Called
 * from `getSessionUser()` — the one place almost every guarded handler
 * resolves the session — so handlers stay wrapper-only.
 */
export function setRequestUser({
	userId,
	sessionId,
}: {
	userId: string;
	sessionId?: string;
}): void {
	const context = storage.getStore();
	if (!context) return;
	context.userId = userId;
	if (sessionId) context.sessionId = sessionId;
}

/**
 * The context shape the logger reads. Field names are the final log keys
 * (nginx sample), built once here so the logger stays storage-agnostic.
 */
function contextSource(): Record<string, unknown> | undefined {
	const context = storage.getStore();
	if (!context) return undefined;
	const elapsed = Date.now() - context.startMs;
	return {
		trace_id: context.traceId,
		remote_addr: context.remoteAddr,
		user_id: context.userId,
		session_id: context.sessionId,
		request_method: context.method,
		request_uri: context.uri,
		status: context.status,
		body_bytes_sent: context.bodyBytes,
		http_referer: context.referer,
		http_user_agent: context.userAgent,
		latency_ms: context.latencyMs ?? elapsed,
		upstream_response_time: context.latencyMs ?? elapsed,
		host: context.host,
	};
}

(globalThis as { __mycutLogContext?: unknown }).__mycutLogContext =
	contextSource;
