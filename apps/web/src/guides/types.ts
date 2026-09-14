import type { ReactNode } from "react";
import type { LocaleKey } from "@/locale";

export interface GridConfig {
	rows: number;
	cols: number;
}

export interface GuideRenderProps {
	width: number;
	height: number;
}

export interface GuideDefinition {
	id: string;
	/** Untranslated label, for brand names (TikTok, Reels, Shorts, Spotlight). */
	label?: string;
	/** Localized label. Takes precedence over `label` when present. */
	labelKey?: LocaleKey;
	renderPreview: () => ReactNode;
	renderTriggerIcon: () => ReactNode;
	renderOverlay: (props: GuideRenderProps) => ReactNode;
	renderOptions?: () => ReactNode;
}
