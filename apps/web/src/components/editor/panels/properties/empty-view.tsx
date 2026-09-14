"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import { Settings05Icon } from "@hugeicons/core-free-icons";
import { useLocale } from "@/locale/locale-context";

export function EmptyView() {
	const { t } = useLocale();

	return (
		<div className="bg-background flex h-full flex-col items-center justify-center gap-3 p-4">
			<HugeiconsIcon
				icon={Settings05Icon}
				className="text-muted-foreground/75 size-10"
				strokeWidth={1}
			/>
			<div className="flex flex-col gap-2 text-center">
				<p className="text-lg font-medium ">{t["properties.empty_title"]}</p>
				<p className="text-muted-foreground text-sm text-balance">
					{t["properties.empty_description"]}
				</p>
			</div>
		</div>
	);
}
