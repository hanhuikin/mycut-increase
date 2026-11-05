"use client";

import { useEffect, useState } from "react";

/**
 * The root error boundary swap-in. Shows the session trace id so a user
 * screenshotting a crash can still hand support an id that matches the
 * server logs (the id is minted client-side and carried on every API call —
 * see services/logging/).
 */
export default function GlobalError({
	error,
	reset,
}: {
	error: Error & { digest?: string };
	reset: () => void;
}) {
	const [traceId, setTraceId] = useState<string | null>(null);
	useEffect(() => {
		setTraceId(window.__TRACE_ID__ ?? null);
		console.error("app crashed", { error, digest: error.digest });
	}, [error]);
	return (
		<html>
			<body className="flex min-h-dvh flex-col items-center justify-center gap-3 p-6 text-center">
				<h2 className="text-lg font-semibold">Something went wrong!</h2>
				{traceId ? (
					<p className="text-muted-foreground font-mono text-xs">
						trace_id: {traceId}
					</p>
				) : null}
				<button
					onClick={() => reset()}
					className="border-border rounded-lg border px-4 py-2 text-sm hover:underline"
				>
					Try again
				</button>
			</body>
		</html>
	);
}
