"use client";

import Link from "next/link";
import { Button } from "./ui/button";
import { ArrowRight } from "lucide-react";
import Image from "next/image";
import { ThemeToggle } from "./theme-toggle";
import {
	Copy01Icon,
	Download01Icon,
	GithubIcon,
	LinkSquare02Icon,
	LanguageSkillIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { DEFAULT_LOGO_URL } from "@/site/brand";
import { SOCIAL_LINKS } from "@/site/social";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "./ui/context-menu";
import { useLocale } from "@/locale/locale-context";

export function Header() {
	const { t, locale, setLocale } = useLocale();

	const toggleLocale = () => {
		setLocale(locale === "zh" ? "en" : "zh");
	};

	return (
		<header className="bg-background shadow-background/85 sticky top-0 z-10 shadow-[0_30px_35px_15px_rgba(0,0,0,1)]">
			<div className="relative flex w-full items-center justify-between px-6 pt-4">
				<div className="relative z-10 flex items-center gap-6">
					<ContextMenu>
						<ContextMenuTrigger asChild>
							<Link href="/" className="flex items-center gap-3">
								<Image
									src={DEFAULT_LOGO_URL}
									alt="MyCut Logo"
									className="invert dark:invert-0"
									width={32}
									height={32}
								/>
								<span className="text-xl font-bold">{t["landing.app_name"]}</span>
							</Link>
						</ContextMenuTrigger>
						<ContextMenuContent>
							<ContextMenuItem
								onClick={async () => {
									const res = await fetch(DEFAULT_LOGO_URL);
									const svg = await res.text();
									await navigator.clipboard.writeText(svg);
								}}
							>
								<HugeiconsIcon icon={Copy01Icon} />
								{t["menu.copy_svg"]}
							</ContextMenuItem>
							<ContextMenuItem
								onClick={() => {
									const a = document.createElement("a");
									a.href = DEFAULT_LOGO_URL;
									a.download = "mycut-logo.svg";
									a.click();
								}}
							>
								<HugeiconsIcon icon={Download01Icon} />
								{t["menu.download_svg"]}
							</ContextMenuItem>
							<Link href="/brand">
								<ContextMenuItem>
									<HugeiconsIcon icon={LinkSquare02Icon} />
									{t["nav.brand_assets"]}
								</ContextMenuItem>
							</Link>
						</ContextMenuContent>
					</ContextMenu>
				</div>

				<div className="relative z-10 flex items-center gap-3">
					<Link href={SOCIAL_LINKS.github} className="hidden sm:block">
						<Button className="bg-background text-sm" variant="outline">
							<HugeiconsIcon icon={GithubIcon} className="size-4" />
							40k+
						</Button>
					</Link>
					<Link href="/projects">
						<Button className="text-sm">
							{t["nav.projects"]}
							<ArrowRight className="size-4" />
						</Button>
					</Link>
					<Button
						variant="outline"
						size="icon"
						onClick={toggleLocale}
						title={t["common.switch_language"]}
					>
						<HugeiconsIcon icon={LanguageSkillIcon} className="size-4" />
					</Button>
					<ThemeToggle />
				</div>
			</div>
		</header>
	);
}
