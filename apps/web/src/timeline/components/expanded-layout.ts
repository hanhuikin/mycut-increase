import type {
	AnimationPath,
	ElementAnimations,
} from "@/animation/types";
import type { TimelineTrack } from "@/timeline";
import { getElementKeyframes } from "@/animation";
import type { LocaleKey, LocaleStrings } from "@/locale";
import { KEYFRAME_LANE_HEIGHT_PX } from "./layout";

export interface ExpandedRow {
	propertyPath: AnimationPath;
}

interface PropertyGroupDefinition {
	matchesPath: (path: AnimationPath) => boolean;
}

const PROPERTY_GROUPS: PropertyGroupDefinition[] = [
	{ matchesPath: (path) => path.startsWith("transform.") || path === "opacity" },
	{ matchesPath: (path) => path === "volume" || path === "color" },
	{ matchesPath: (path) => path.startsWith("background.") },
	{ matchesPath: (path) => path.startsWith("params.") },
	{ matchesPath: (path) => path.startsWith("effects.") },
];

const PROPERTY_LABEL_KEYS: Partial<Record<string, LocaleKey>> = {
	"transform.positionX": "prop.position_x",
	"transform.positionY": "prop.position_y",
	"transform.scaleX": "prop.scale_x",
	"transform.scaleY": "prop.scale_y",
	"transform.rotate": "prop.rotation",
	opacity: "prop.opacity",
	volume: "prop.volume",
	color: "prop.color",
	"background.color": "prop.bg_color",
	"background.paddingX": "prop.bg_pad_x",
	"background.paddingY": "prop.bg_pad_y",
	"background.offsetX": "prop.bg_offset_x",
	"background.offsetY": "prop.bg_offset_y",
	"background.cornerRadius": "prop.corner_radius",
};

/**
 * Resolves a keyframe property path to a display label. Effect and graphic
 * param paths fall back to their raw segment: those names come from user
 * plugins and definition registries, so there is no key to translate.
 */
export function getPropertyLabel({
	path,
	t,
}: {
	path: AnimationPath;
	t: LocaleStrings;
}): string {
	const key = PROPERTY_LABEL_KEYS[path];
	if (key) return t[key];
	if (path.startsWith("params.")) return path.slice("params.".length);
	if (path.startsWith("effects.")) {
		const parts = path.split(".");
		return parts[parts.length - 1];
	}
	return path;
}

export function getExpandedRows({
	animations,
}: {
	animations: ElementAnimations | undefined;
}): ExpandedRow[] {
	const keyframes = getElementKeyframes({ animations });
	const propertyPaths = [...new Set(keyframes.map((kf) => kf.propertyPath))];
	if (propertyPaths.length === 0) return [];

	const rows: ExpandedRow[] = [];

	for (const group of PROPERTY_GROUPS) {
		const groupPaths = propertyPaths.filter((path) =>
			group.matchesPath(path),
		);
		for (const path of groupPaths) {
			rows.push({ propertyPath: path });
		}
	}

	return rows;
}

export function getExpansionHeight({ rows }: { rows: ExpandedRow[] }): number {
	return rows.length * KEYFRAME_LANE_HEIGHT_PX;
}

export function computeTrackExpansionHeight({
	track,
	expandedElementIds,
}: {
	track: TimelineTrack;
	expandedElementIds: Set<string>;
}): number {
	let maxHeight = 0;
	for (const element of track.elements) {
		if (!expandedElementIds.has(element.id)) continue;
		const rows = getExpandedRows({ animations: element.animations });
		maxHeight = Math.max(maxHeight, getExpansionHeight({ rows }));
	}
	return maxHeight;
}

export function getTrackExpandedRows({
	track,
	expandedElementIds,
}: {
	track: TimelineTrack;
	expandedElementIds: Set<string>;
}): ExpandedRow[] {
	let maxHeight = 0;
	let maxRows: ExpandedRow[] = [];

	for (const element of track.elements) {
		if (!expandedElementIds.has(element.id)) continue;
		const rows = getExpandedRows({ animations: element.animations });
		const height = getExpansionHeight({ rows });
		if (height > maxHeight) {
			maxHeight = height;
			maxRows = rows;
		}
	}

	return maxRows;
}
