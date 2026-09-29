"use client";

import type { ReactNode } from "react";
import Image from "next/image";
import { DEFAULT_LOGO_URL } from "@/site/brand";
import { useLocale } from "@/locale/locale-context";

/** Split layout for the auth pages: brand panel on the left (desktop), form slot on the right. */
export default function AuthLayout({ children }: { children: ReactNode }) {
	const { t } = useLocale();

	return (
		<div className="bg-background grid min-h-screen lg:grid-cols-2">
			<div className="bg-primary/10 relative hidden flex-col justify-between overflow-hidden p-9 lg:flex">
				<div
					aria-hidden
					className="pointer-events-none absolute inset-x-0 bottom-0 h-24 opacity-40 [mask-image:linear-gradient(180deg,transparent,#000_70%)] bg-[repeating-linear-gradient(0deg,transparent_0_23px,hsl(var(--border))_23px_24px)]"
				/>
				<div className="relative flex items-center gap-2.5">
					<Image
						src={DEFAULT_LOGO_URL}
						alt="MyCut"
						width={24}
						height={24}
						className="size-6 invert dark:invert-0"
					/>
					<span className="text-lg font-bold">MyCut</span>
				</div>
				<h2 className="relative text-2xl font-bold leading-snug tracking-tight">
					{t["auth.login.brand_line1"]}
					<br />
					{t["auth.login.brand_line2"]}
				</h2>
				<div className="relative font-mono text-[10.5px] tracking-[0.1em] text-muted-foreground">
					TIMELINE · TRACKS · KEYFRAMES
				</div>
			</div>
			<div className="flex items-center justify-center p-6">
				<div className="w-full max-w-sm">{children}</div>
			</div>
		</div>
	);
}
