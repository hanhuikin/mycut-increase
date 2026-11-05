/**
 * The trace id the browser session stamps onto every API call, mirrored onto
 * `window` (and `<html data-trace-id>`) so a user can quote it when
 * reporting a problem — see services/logging/trace.ts.
 */
declare global {
	interface Window {
		__TRACE_ID__?: string;
		/** Set by the beforeInteractive snippet in layout.tsx once fetch is wrapped. */
		__traceFetchPatched?: boolean;
		mycutCopyTraceId?: () => void;
	}
}

// Ambient declarations only; the export keeps this file a module so the
// `declare global` block above is legal.
export {};
