"use client";

import { Languages } from "lucide-react";
import { Button } from "./ui/button";
import { useLocale } from "@/locale/locale-context";
import { cn } from "@/utils/ui";

interface LanguageToggleProps {
	className?: string;
	iconClassName?: string;
}

/** zh ⇄ en switch — persistence lives in LocaleProvider (localStorage). */
export function LanguageToggle({
	className,
	iconClassName,
}: LanguageToggleProps) {
	const { t, locale, setLocale } = useLocale();

	return (
		<Button
			size="icon"
			variant="ghost"
			className={cn("size-8", className)}
			onClick={() => setLocale(locale === "zh" ? "en" : "zh")}
			title={t["common.switch_language"]}
		>
			<Languages
				className={cn("!size-[1.1rem]", iconClassName)}
				strokeWidth={1.5}
			/>
			<span className="sr-only">{t["common.switch_language"]}</span>
		</Button>
	);
}
