import { NextResponse, type NextRequest } from "next/server";
import { logger } from "./logger";
import {
	runWithRequestContext,
	type RequestLogContext,
} from "./request-context";
import { pickTraceId, TRACE_HEADER } from "./trace";

/**
 * Wraps an API route handler to (a) bind a per-request log context — trace id
 * honoured from the client's `x-trace-id` header, else generated — and (b)
 * emit one nginx-style JSON access line per request: method, uri, status,
 * bytes, latency, client ip, UA. That is the log ops screens in the sample
 * format, and the line whose `trace_id` answers "which server logs match the
 * id shown on my page".
 *
 * Health probes log at DEBUG (a probe every few seconds per pod would drown
 * INFO); 4xx answers WARN, 5xx/throws ERROR. Unhandled errors also return
 * `trace_id` in the JSON body, so a caller can quote exactly this request.
 */

const DEBUG_PATHS = new Set(["/api/health", "/api/health/deep"]);

function firstForwarded(value: string | null): string {
	return value?.split(",")[0]?.trim() ?? "";
}

/** The logger's method name for a response status. */
function statusLevel(
	status: number,
): "error" | "warn" | "info" {
	if (status >= 500) return "error";
	if (status >= 400) return "warn";
	return "info";
}

/** Some responses ship immutable headers; fall back to a rebuild. */
function withTraceHeader(response: Response, traceId: string): Response {
	try {
		response.headers.set(TRACE_HEADER, traceId);
		return response;
	} catch {
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: new Headers([...response.headers, [TRACE_HEADER, traceId]]),
		});
	}
}

export function withRoute<Args extends unknown[]>(
	handler: (
		request: NextRequest,
		...args: Args
	) => Response | Promise<Response>,
): (request: NextRequest, ...args: Args) => Promise<Response> {
	return async (request, ...args) => {
		const url = new URL(request.url);
		const traceId = pickTraceId(request.headers.get(TRACE_HEADER));
		const context: RequestLogContext = {
			traceId,
			method: request.method,
			uri: `${url.pathname}${url.search}`,
			host: firstForwarded(request.headers.get("x-forwarded-host")) || url.host,
			remoteAddr: firstForwarded(request.headers.get("x-forwarded-for")),
			userAgent: request.headers.get("user-agent") ?? "",
			referer: request.headers.get("referer") ?? "",
			startMs: Date.now(),
		};
		return runWithRequestContext(context, async () => {
			let response: Response;
			try {
				response = await handler(request, ...args);
			} catch (error) {
				logger.error("unhandled route error", { error });
				response = NextResponse.json(
					{ error: "internal_error", trace_id: traceId },
					{ status: 500 },
				);
			}
			context.status = response.status;
			const contentLength = response.headers.get("content-length");
			if (contentLength && /^\d+$/.test(contentLength)) {
				context.bodyBytes = Number(contentLength);
			}
			// `latencyMs ?? elapsed` in request-context means the access line
			// uses this settled value, while any log an event during handling
			// already saw the live elapsed time.
			context.latencyMs = Date.now() - context.startMs;
			const level = DEBUG_PATHS.has(url.pathname)
				? "debug"
				: statusLevel(response.status);
			logger[level](
				context.status >= 400 ? "api request failed" : "api request",
				{
					route_error:
						response.status >= 400 &&
						response.headers.get("content-type")?.includes("application/json")
							? ((await peekJsonError(response)) ?? undefined)
							: undefined,
				},
			);
			return withTraceHeader(response, traceId);
		});
	};
}

/**
 * The access line gains the handler's own error code (e.g. `rate_limited`,
 * `unauthenticated`) without handlers having to log it themselves. Reading
 * the body clones it, so the caller still gets the original stream.
 */
async function peekJsonError(response: Response): Promise<string | null> {
	try {
		const clone = response.clone();
		const body = (await clone.json()) as { error?: unknown };
		return typeof body.error === "string" ? body.error : null;
	} catch {
		return null;
	}
}
