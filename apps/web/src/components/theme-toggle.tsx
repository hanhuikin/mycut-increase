"use client";

import { useEffect, useState } from "react";
import { Button } from "./ui/button";
import { useTheme } from "next-themes";
import { useLocale } from "@/locale/locale-context";
import { cn } from "@/utils/ui";
import { Sun03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

interface ThemeToggleProps {
	className?: string;
	iconClassName?: string;
	onToggle?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}

export function ThemeToggle({
	className,
	iconClassName,
	onToggle,
}: ThemeToggleProps) {
	const { resolvedTheme, setTheme } = useTheme();
	const { t } = useLocale();
	// The active theme lives in localStorage / the OS preference, so the server
	// cannot know it. Until mount, render a label that reads the same either way.
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	const isDark = resolvedTheme === "dark";

	return (
		<Button
			size="icon"
			variant="ghost"
			className={cn("size-8", className)}
			onClick={(e) => {
				setTheme(isDark ? "light" : "dark");
				onToggle?.(e);
			}}
		>
			<HugeiconsIcon
				icon={Sun03Icon}
				className={cn("!size-[1.1rem]", iconClassName)}
			/>
			<span className="sr-only">
				{mounted
					? isDark
						? t["theme.light"]
						: t["theme.dark"]
					: t["theme.toggle"]}
			</span>
		</Button>
	);
}
