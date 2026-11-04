/**
 * Server bootstrap — runs once before any request is handled.
 *
 * Bun implements `WebAssembly.instantiate` but not `WebAssembly.instantiateStreaming`.
 * Turbopack's SSR runtime uses the streaming variant to load .wasm modules, so
 * `next dev` / `bun server.js` crash on module evaluation of opencut-wasm
 * ("WebAssembly.instantiateStreaming is not a function"). Polyfill it with the
 * buffered equivalent when missing; no-op under Node where both exist.
 */
export async function register() {
	if (
		typeof WebAssembly === "undefined" ||
		typeof WebAssembly.instantiateStreaming === "function"
	) {
		return;
	}

	const bufferedInstantiateStreaming = async (
		responseOrPromise: Response | Promise<Response>,
		importsObject?: WebAssembly.Imports,
	): Promise<WebAssembly.WebAssemblyInstantiatedSource> => {
		const response = await responseOrPromise;
		const bytes = await response.arrayBuffer();
		return WebAssembly.instantiate(bytes, importsObject);
	};

	WebAssembly.instantiateStreaming =
		bufferedInstantiateStreaming as typeof WebAssembly.instantiateStreaming;
}
