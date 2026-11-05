"use client";

import { useEffect } from "react";
import { logger } from "./logger";
import { ensureClientTraceId, TRACE_HEADER } from "./trace";

/**
 * One-time client wiring for the trace/log system. The heavy lifting —
 * minting the trace id, wrapping fetch — happens earlier, in the
 * beforeInteractive snippet injected by layout.tsx (better-auth snapshots
 * `fetch` at module-evaluation time, so a React-effect patch would run too
 * late). This component adds what can wait for hydration:
 *
 * - a boot log line carrying the trace id (the page-visible id a user can
 *   quote in a bug report);
 * - a component-level fetch wrap with richer logging, only when the early
 *   snippet did not run (defensive fallback);
 * - window error / unhandledrejection forwarding into the same JSON format.
 */
export function LogBootstrap() {
	useEffect(() => {
		const traceId = ensureClientTraceId();
		document.documentElement.dataset.traceId = traceId;
		window.mycutCopyTraceId = () => {
			void navigator.clipboard?.writeText(traceId);
		};
		logger.info("client session started", {
			path: window.location.pathname,
			trace_hint: "trace_id above — provide it when reporting issues",
		});

		const restoreFetch = window.__traceFetchPatched
			? null
			: installFetchWrap(traceId);

		const onError = (event: ErrorEvent) => {
			logger.error("window error", {
				error: event.error ?? new Error(event.message),
				path: window.location.pathname,
			});
		};
		const onRejection = (event: PromiseRejectionEvent) => {
			logger.error("unhandled rejection", {
				error:
					event.reason instanceof Error ? event.reason : String(event.reason),
				path: window.location.pathname,
			});
		};
		window.addEventListener("error", onError);
		window.addEventListener("unhandledrejection", onRejection);
		return () => {
			window.removeEventListener("error", onError);
			window.removeEventListener("unhandledrejection", onRejection);
			restoreFetch?.();
			delete window.mycutCopyTraceId;
		};
	}, []);

	return null;
}

/** Fallback wrap (the snippet normally owns this): header + log lines. */
function installFetchWrap(traceId: string): () => void {
	const originalFetch = window.fetch.bind(window);
	window.fetch = async (input, init) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.href
					: input.url;
		let parsed: URL;
		try {
			parsed = new URL(url, window.location.origin);
		} catch {
			return originalFetch(input, init);
		}
		if (
			parsed.origin !== window.location.origin ||
			!parsed.pathname.startsWith("/api/")
		) {
			return originalFetch(input, init);
		}
		const headers = new Headers(
			input instanceof Request ? input.headers : undefined,
		);
		if (init?.headers)
			new Headers(init.headers).forEach((value, key) =>
				headers.set(key, value),
			);
		headers.set(TRACE_HEADER, traceId);
		const started = performance.now();
		try {
			const response = await originalFetch(
				input instanceof Request ? new Request(input, { headers }) : input,
				{ ...init, headers },
			);
			const fields = {
				request_method:
					init?.method ?? (input instanceof Request ? input.method : "GET"),
				request_uri: `${parsed.pathname}${parsed.search}`,
				status: response.status,
				latency_ms: Math.round(performance.now() - started),
			};
			if (response.status >= 500) logger.error("api server error", fields);
			else if (response.status >= 400)
				logger.warn("api request rejected", fields);
			else logger.debug("api request ok", fields);
			return response;
		} catch (error) {
			logger.error("api network error", {
				request_uri: `${parsed.pathname}${parsed.search}`,
				error,
			});
			throw error;
		}
	};
	return () => {
		window.fetch = originalFetch;
	};
}
