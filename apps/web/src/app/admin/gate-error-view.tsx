"use client";

import { usePathname } from "next/navigation";
import { Button } from "@/components/ui/button";
import type { LocaleKey } from "@/locale";
import { useLocale } from "@/locale/locale-context";

export type GateStatus = "401" | "403" | "428";

/**
 * Not every failed request is a gate failure. Treating a 500 or a dropped
 * connection as one renders "verify again" for something verifying cannot fix —
 * which reads as a page that simply will not open, no matter how many times the
 * admin re-verifies.
 *
 * `fetch` reports `status` as a number, so both forms are accepted: comparing a
 * numeric 428 against string literals silently misses the gate case.
 */
export function isGateStatus(status: string | number): status is GateStatus {
	const value = String(status);
	return value === "401" || value === "403" || value === "428";
}

/**
 * The copy and destination for each gate status. Kept as a pure function so the
 * numeric/string handling is testable — it is the same trap that made a gate
 * failure look like an unopenable page.
 */
export function gateCopy(status: string | number): {
	messageKey: LocaleKey;
	linkLabelKey: LocaleKey;
	path: "/login" | "/admin/enter";
} {
	const value = String(status);
	if (value === "403") {
		// Signed in, but not an admin — a different account is the way out.
		return {
			messageKey: "admin.error.403",
			linkLabelKey: "auth.menu.login",
			path: "/login",
		};
	}
	if (value === "428") {
		// Signed in, just not elevated yet.
		return {
			messageKey: "admin.error.428",
			linkLabelKey: "admin.gate.submit",
			path: "/admin/enter",
		};
	}
	return {
		messageKey: "admin.error.401",
		linkLabelKey: "auth.menu.login",
		path: "/login",
	};
}

/**
 * The shared surface every admin page shows when the elevated-admin gate
 * rejects a request. Lives outside the route tree so pages don't have to
 * import one another.
 */
export function GateErrorView({ status }: { status: GateStatus | number }) {
	const { t } = useLocale();
	const pathname = usePathname();
	const copy = gateCopy(status);
	// Both destinations honour `next`, so re-authenticating returns you to the
	// page you were on instead of dropping you in the editor.
	const href = `${copy.path}?next=${encodeURIComponent(pathname)}`;

	return (
		<div className="flex flex-col items-center gap-3 pt-16 text-center">
			<p className="text-muted-foreground text-[15px]">{t[copy.messageKey]}</p>
			<a href={href} className="text-primary hover:underline text-[15px]">
				{t[copy.linkLabelKey]}
			</a>
		</div>
	);
}

/** The request failed for a reason the gate cannot explain. */
export function LoadErrorView({
	status,
	onRetry,
}: {
	status: string;
	onRetry: () => void;
}) {
	const { t } = useLocale();
	return (
		<div className="flex flex-col items-center gap-3 pt-16 text-center">
			<p className="text-muted-foreground text-[15px]">
				{t["admin.error.load_failed"].replace("{status}", status)}
			</p>
			<Button variant="outline" size="sm" onClick={onRetry}>
				{t["admin.error.retry"]}
			</Button>
		</div>
	);
}
