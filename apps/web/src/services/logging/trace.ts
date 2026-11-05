/**
 * Trace ids tie every log line of one logical request together, and the
 * browser exposes its id so a user can quote it when reporting a problem —
 * support then greps exactly one id across server and client logs.
 *
 * Format: 12 lowercase hex chars (48 bits), same shape as the ops access-log
 * sample. Short enough to read out over a call, long enough to stay collision
 * -free within a service lifetime.
 */
export const TRACE_HEADER = "x-trace-id";

const TRACE_ID_RE = /^[0-9a-f]{12}$/;

function randomHex(byteCount: number): string {
	const bytes = new Uint8Array(byteCount);
	crypto.getRandomValues(bytes);
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

export function newTraceId(): string {
	return randomHex(6);
}

export function isValidTraceId(
	value: string | null | undefined,
): value is string {
	return TRACE_ID_RE.test(value ?? "");
}

/**
 * Clamps whatever arrived into a valid trace id: a client-supplied id is
 * honoured verbatim, anything malformed is replaced. Call this on the server
 * before trusting the header.
 */
export function pickTraceId(value: string | null | undefined): string {
	return isValidTraceId(value) ? value : newTraceId();
}

const CLIENT_TRACE_STORAGE_KEY = "mycut.trace-id";

/**
 * The earliest possible client wiring, injected as a `beforeInteractive`
 * inline script (see layout.tsx): it must run before the app bundle because
 * better-auth snapshots `fetch` at module-evaluation time — a patch installed
 * in a later effect would never see its requests, and their access lines
 * would log a server-minted trace id instead of the page's. This snippet
 * mints the session trace id, mirrors it onto window/documentElement, and
 * wraps fetch so every same-origin /api/* call carries `x-trace-id` (4xx/5xx
 * answered with a WARN/ERROR JSON line in the same format as the server's).
 * LogBootstrap detects the wrap via `window.__traceFetchPatched` and only
 * adds its error listeners on top.
 */
export const TRACE_BOOT_SNIPPET = `(function(){
try {
  var re = /^[0-9a-f]{12}$/;
  var id = null;
  try { id = window.sessionStorage.getItem("${CLIENT_TRACE_STORAGE_KEY}"); } catch (e) {}
  if (!id || !re.test(id)) {
    var bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    id = Array.prototype.map.call(bytes, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
    try { window.sessionStorage.setItem("${CLIENT_TRACE_STORAGE_KEY}", id); } catch (e) {}
  }
  window.__TRACE_ID__ = id;
  document.documentElement.dataset.traceId = id;
  if (window.__traceFetchPatched) return;
  var original = window.fetch ? window.fetch.bind(window) : null;
  if (!original) return;
  window.__traceFetchPatched = true;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    var parsed = null;
    try { parsed = new URL(url, location.origin); } catch (e) {}
    var sameApi = parsed && parsed.origin === location.origin && parsed.pathname.indexOf("/api/") === 0;
    if (!sameApi) return original(input, init);
    var headers = new Headers(input instanceof Request ? input.headers : undefined);
    if (init && init.headers) new Headers(init.headers).forEach(function (v, k) { headers.set(k, v); });
    headers.set("x-trace-id", id);
    var method = (init && init.method) || (input instanceof Request ? input.method : "GET");
    var uri = parsed.pathname + parsed.search;
    var started = performance.now();
    var send = input instanceof Request ? new Request(input, { headers: headers }) : input;
    return original(send, init && init.headers ? { ...init, headers: headers } : init)
      .then(function (response) {
        var fields = {
          timestamp: new Date().toISOString(), service: "mycut-web",
          trace_id: id, request_method: method, request_uri: uri,
          status: response.status,
          latency_ms: Math.round(performance.now() - started),
          host: location.host, msg: "api request"
        };
        if (response.status >= 500) console.error(JSON.stringify({ ...fields, level: "ERROR" }));
        else if (response.status >= 400) console.warn(JSON.stringify({ ...fields, level: "WARN" }));
        return response;
      })
      .catch(function (error) {
        console.error(JSON.stringify({
          timestamp: new Date().toISOString(), service: "mycut-web", level: "ERROR",
          trace_id: id, request_uri: uri, host: location.host, msg: "api network error",
          error: String(error && error.message || error)
        }));
        throw error;
      });
  };
} catch (e) {}
})();`;

/**
 * The browser session's trace id: one id per tab (sessionStorage), reused by
 * every API call it makes, so the id shown on the page correlates the whole
 * session's logs. Falls back to a fresh id when storage is unavailable
 * (Safari private mode).
 */
export function ensureClientTraceId(): string {
	if (typeof window === "undefined") return newTraceId();
	const existing = window.__TRACE_ID__;
	if (isValidTraceId(existing)) return existing;
	try {
		const stored = window.sessionStorage.getItem(CLIENT_TRACE_STORAGE_KEY);
		if (isValidTraceId(stored)) {
			window.__TRACE_ID__ = stored;
			return stored;
		}
	} catch {
		// Storage blocked — a per-load id still works.
	}
	const id = newTraceId();
	window.__TRACE_ID__ = id;
	try {
		window.sessionStorage.setItem(CLIENT_TRACE_STORAGE_KEY, id);
	} catch {
		// Ignore: the id lives on `window` either way.
	}
	return id;
}
