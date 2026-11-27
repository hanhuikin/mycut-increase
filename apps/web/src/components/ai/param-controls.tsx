"use client";

/**
 * AI 生图对话框共用的参数控件：分段选项 chip、自定义尺寸输入与吸附提示。
 * 多图生图（img2img-dialog）与文生图（text2img-dialog）共用同一套，
 * 尺寸能力常量与校验也统一来自 img2img-store。
 */

import React from "react";
import { useLocale } from "@/locale/locale-context";
import { IMG2IMG_SIZE_CAPS, validateCustomSize } from "./img2img-store";
import { cn } from "@/utils/ui";

/** Radix PopoverTrigger 的 asChild 需要 ref 且会透传 aria/data-* 与事件，因此必须展开 rest。 */
export const ParamChip = React.forwardRef<
	HTMLButtonElement,
	React.ComponentPropsWithoutRef<"button"> & {
		label: string;
		selected: boolean;
	}
>(function ParamChip({ label, selected, className, ...rest }, ref) {
	return (
		<button
			ref={ref}
			type="button"
			className={cn(
				"px-2 py-1 text-[10px] whitespace-nowrap transition-colors disabled:opacity-50",
				selected
					? "bg-primary text-white"
					: "text-muted-foreground hover:text-foreground",
				className,
			)}
			{...rest}
		>
			{label}
		</button>
	);
});

export function SizeInput({
	label,
	value,
	onChange,
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<label className="flex items-center gap-1 text-[11px]">
			<span className="text-muted-foreground">{label}</span>
			<input
				inputMode="numeric"
				value={value}
				className="border-border bg-card w-16 rounded-md border px-2 py-1 text-[11px] outline-none"
				onChange={(event) => onChange(event.target.value.replace(/[^\d]/g, ""))}
			/>
		</label>
	);
}

/** 吸附预览 / 越界提示。 */
export function SizeHint({ draftW, draftH }: { draftW: string; draftH: string }) {
	const { t } = useLocale();
	const w = Number(draftW);
	const h = Number(draftH);
	const applied = validateCustomSize(w, h);
	const { minEdge, maxEdge, step } = IMG2IMG_SIZE_CAPS;
	if (!applied) {
		return (
			<div className="mt-2 text-[10px] text-red-400">
				{t["ai_img2img.size_invalid"]
					.replace("{min}", String(minEdge))
					.replace("{max}", String(maxEdge))
					.replace("{maxPixels}", `${maxEdge}×${maxEdge}`)}
			</div>
		);
	}
	return (
		<div className="text-blue-300 mt-2 text-[10px]">
			{t["ai_img2img.size_snap_applied"]
				.replace("{size}", `${applied.w}×${applied.h}`)
				.replace("{step}", String(step))
				.replace("{maxEdge}", String(maxEdge))
				.replace("{maxPixels}", `${maxEdge}×${maxEdge}`)}
		</div>
	);
}
