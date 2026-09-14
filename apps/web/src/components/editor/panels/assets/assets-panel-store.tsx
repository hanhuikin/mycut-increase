import type { ElementType } from "react";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
	ArrowRightDoubleIcon,
	ClosedCaptionIcon,
	Folder03Icon,
	Happy01Icon,
	HeadphonesIcon,
	MagicWand05Icon,
	MusicNote01Icon,
	TextIcon,
	Settings01Icon,
	SlidersHorizontalIcon,
	Video02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import type { Translations } from "@/locale";

export const TAB_KEYS = [
	"media",
	"sounds",
	"text",
	"stickers",
	"effects",
	"transitions",
	"captions",
	"adjustment",
	"ai-video",
	"ai-tools",
	"ai-audio",
	"settings",
] as const;

export type Tab = (typeof TAB_KEYS)[number];

const createHugeiconsIcon =
	({ icon }: { icon: IconSvgElement }) =>
	({ className }: { className?: string }) => (
		<HugeiconsIcon icon={icon} className={className} />
	);

export const getTabConfig = (t: Translations) => ({
	media: {
		icon: createHugeiconsIcon({ icon: Folder03Icon }),
		label: t["tab.media"],
	},
	sounds: {
		icon: createHugeiconsIcon({ icon: HeadphonesIcon }),
		label: t["tab.sounds"],
	},
	text: {
		icon: createHugeiconsIcon({ icon: TextIcon }),
		label: t["tab.text"],
	},
	stickers: {
		icon: createHugeiconsIcon({ icon: Happy01Icon }),
		label: t["tab.stickers"],
	},
	effects: {
		icon: createHugeiconsIcon({ icon: MagicWand05Icon }),
		label: t["tab.effects"],
	},
	transitions: {
		icon: createHugeiconsIcon({ icon: ArrowRightDoubleIcon }),
		label: t["tab.transitions"],
	},
	captions: {
		icon: createHugeiconsIcon({ icon: ClosedCaptionIcon }),
		label: t["tab.captions"],
	},
	adjustment: {
		icon: createHugeiconsIcon({ icon: SlidersHorizontalIcon }),
		label: t["tab.adjustment"],
	},
	"ai-video": {
		icon: createHugeiconsIcon({ icon: Video02Icon }),
		label: t["tab.ai_video"],
	},
	"ai-tools": {
		icon: createHugeiconsIcon({ icon: MagicWand05Icon }),
		label: t["tab.ai_tools"],
	},
	"ai-audio": {
		icon: createHugeiconsIcon({ icon: MusicNote01Icon }),
		label: t["tab.ai_audio"],
	},
	settings: {
		icon: createHugeiconsIcon({ icon: Settings01Icon }),
		label: t["tab.settings"],
	},
});

export type MediaViewMode = "grid" | "list";
export type MediaSortKey = "name" | "type" | "duration" | "size";
export type MediaSortOrder = "asc" | "desc";

interface AssetsPanelStore {
	activeTab: Tab;
	setActiveTab: (tab: Tab) => void;
	highlightMediaId: string | null;
	requestRevealMedia: (mediaId: string) => void;
	clearHighlight: () => void;

	/* Media */
	mediaViewMode: MediaViewMode;
	setMediaViewMode: (mode: MediaViewMode) => void;
	mediaSortBy: MediaSortKey;
	mediaSortOrder: MediaSortOrder;
	setMediaSort: (args: { key: MediaSortKey; order: MediaSortOrder }) => void;
}

export const useAssetsPanelStore = create<AssetsPanelStore>()(
	persist(
		(set) => ({
			activeTab: "media",
			setActiveTab: (tab) => set({ activeTab: tab }),
			highlightMediaId: null,
			requestRevealMedia: (mediaId) =>
				set({ activeTab: "media", highlightMediaId: mediaId }),
			clearHighlight: () => set({ highlightMediaId: null }),
			mediaViewMode: "grid",
			setMediaViewMode: (mode) => set({ mediaViewMode: mode }),
			mediaSortBy: "name",
			mediaSortOrder: "asc",
			setMediaSort: ({ key, order }) =>
				set({ mediaSortBy: key, mediaSortOrder: order }),
		}),
		{
			name: "assets-panel",
			partialize: (state) => ({
				mediaViewMode: state.mediaViewMode,
				mediaSortBy: state.mediaSortBy,
				mediaSortOrder: state.mediaSortOrder,
			}),
		},
	),
);
