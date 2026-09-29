"use client";

import { useEffect, useState, type ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
	ArrowLeft,
	Boxes,
	Cable,
	Coins,
	LayoutDashboard,
	ScrollText,
	Users,
} from "lucide-react";
import { DEFAULT_LOGO_URL } from "@/site/brand";
import { useLocale } from "@/locale/locale-context";
import { authClient } from "@/auth/client";

export const GATE_STORAGE_KEY = "mc_admin_gate_until";

function readGateUntil(): number | null {
	const raw = sessionStorage.getItem(GATE_STORAGE_KEY);
	const value = raw ? Number(raw) : NaN;
	return Number.isFinite(value) ? value : null;
}

/** Admin shell: top bar with the elevated-session state + section nav. */
export default function AdminLayout({ children }: { children: ReactNode }) {
	const { t } = useLocale();
	const { data: session, isPending } = authClient.useSession();

	useEffect(() => {
		// Lift the panel's type scale one step. Applied to <body> rather than this
		// subtree so portalled overlays grow too; see the admin type rules in
		// globals.css.
		document.body.classList.add("admin-surface");
		return () => document.body.classList.remove("admin-surface");
	}, []);

	const isAdmin =
		(session?.user as { role?: string } | undefined)?.role === "admin";

	return (
		<div className="bg-background flex min-h-screen flex-col">
			<div className="bg-card border-border flex items-center gap-3.5 border-b px-6 py-3">
				<Link href="/" className="flex items-center gap-2">
					<Image
						src={DEFAULT_LOGO_URL}
						alt="MyCut"
						width={22}
						height={22}
						className="size-5 invert dark:invert-0"
					/>
					<span className="text-[15px] font-bold">
						{t["admin.panel.title"]}
					</span>
				</Link>
				<GateIndicator />
			</div>
			<div className="flex flex-1 flex-col md:grid md:grid-cols-[196px_1fr]">
				<AdminNav />
				<main className="min-w-0 flex-1 p-5 md:p-7">
					{!isPending && !isAdmin ? (
						<ForbiddenNotice />
					) : (
						children
					)}
				</main>
			</div>
		</div>
	);
}

/**
 * Owns the one-second ticker.
 *
 * Keeping this state inside the shell would re-render the whole page — charts
 * included — every second. It relies on React bailing out of an unchanged
 * `children` element, which any context change can break, so the timer lives in
 * its own leaf instead: the shell itself never re-renders.
 */
function GateIndicator() {
	const { t } = useLocale();
	const pathname = usePathname();
	const [gateUntil, setGateUntil] = useState<number | null>(null);
	const [now, setNow] = useState(() => Date.now());

	useEffect(() => {
		// Re-read on every tick rather than once on mount: the gate is issued by
		// the child /admin/enter route, which does not remount this shell.
		const tick = () => {
			setGateUntil(readGateUntil());
			setNow(Date.now());
		};
		tick();
		const timer = setInterval(tick, 1000);
		return () => clearInterval(timer);
	}, []);

	const remainingMs = gateUntil ? gateUntil - now : 0;
	const remaining =
		remainingMs > 0
			? `${String(Math.floor(remainingMs / 60000)).padStart(2, "0")}:${String(
					Math.floor((remainingMs % 60000) / 1000),
				).padStart(2, "0")}`
			: null;
	const expiringSoon = remainingMs > 0 && remainingMs < 5 * 60 * 1000;

	if (!remaining) {
		// Come back here afterwards, unless here *is* the verification page.
		const back = pathname === "/admin/enter" ? "/admin/users" : pathname;
		return (
			<Link
				href={`/admin/enter?next=${encodeURIComponent(back)}`}
				className="border-destructive/50 text-destructive hover:bg-destructive/10 ml-auto inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[13px]"
			>
				<span className="bg-destructive size-1.5 rounded-full" />
				{t["admin.gate.revalidate"]}
			</Link>
		);
	}

	return (
		<span
			className={`ml-auto inline-flex items-center gap-2 rounded-full border px-3 py-1 font-mono text-[13px] ${
				expiringSoon
					? "border-destructive/50 text-destructive"
					: "border-primary/50 text-primary"
			}`}
		>
			<span
				className={`size-1.5 animate-pulse rounded-full ${
					expiringSoon ? "bg-destructive" : "bg-primary"
				}`}
			/>
			{t["admin.session.left"].replace("{time}", remaining)}
		</span>
	);
}

function ForbiddenNotice() {
	const { t } = useLocale();
	return (
		<div className="flex flex-col items-center gap-3 pt-20 text-center">
			<p className="text-muted-foreground text-[15px]">{t["admin.error.403"]}</p>
			<Link href="/login" className="text-primary hover:underline text-[15px]">
				{t["auth.menu.login"]}
			</Link>
		</div>
	);
}

function AdminNav() {
	const pathname = usePathname();
	const { t } = useLocale();
	const links = [
		{
			href: "/admin/dashboard",
			label: t["admin.nav.dashboard"],
			icon: LayoutDashboard,
		},
		{ href: "/admin/users", label: t["admin.nav.users"], icon: Users },
		{ href: "/admin/models", label: t["admin.nav.models"], icon: Boxes },
		{ href: "/admin/channels", label: t["admin.nav.channels"], icon: Cable },
		{ href: "/admin/billing", label: t["admin.nav.billing"], icon: Coins },
		{ href: "/admin/audit", label: t["admin.nav.audit"], icon: ScrollText },
		// Leaves the panel rather than being one of its sections, so it is set
		// apart by a rule.
		{
			href: "/projects",
			label: t["admin.nav.back"],
			icon: ArrowLeft,
			detached: true,
		},
	];
	return (
		<nav className="border-border/60 flex gap-1 overflow-x-auto border-b p-3 md:flex-col md:border-b-0 md:border-r">
			{links.map((link) => {
				const Icon = link.icon;
				return (
					<Link
						key={link.href}
						href={link.href}
						data-active={
							pathname === link.href || pathname.startsWith(`${link.href}/`)
						}
						className={`text-foreground/70 hover:text-foreground hover:bg-accent inline-flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-[15px] whitespace-nowrap data-[active=true]:bg-primary/10 data-[active=true]:text-primary ${
							link.detached
								? "md:border-border/60 md:mt-1.5 md:border-t md:pt-2.5"
								: ""
						}`}
					>
						<Icon className="size-4 shrink-0" aria-hidden />
						{link.label}
					</Link>
				);
			})}
		</nav>
	);
}
