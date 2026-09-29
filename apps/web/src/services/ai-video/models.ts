import type { LocaleKey, LocaleStrings } from "@/locale";

export type VideoGenMode = "text-to-video" | "image-to-video";

export type CameraMovement =
	| "auto"
	| "fixed"
	| "zoom-in"
	| "zoom-out"
	| "pan-left"
	| "pan-right";

/**
 * `LocaleKey` is a closed union derived from the Chinese dictionary, so a
 * string that arrives from the database needs narrowing before it can index a
 * dictionary.
 */
export function isLocaleKey(
	key: string | null | undefined,
	t: LocaleStrings,
): key is LocaleKey {
	return typeof key === "string" && key in t;
}

/**
 * Model copy has two possible sources: a locale key (seed data) or the plain
 * label an admin typed into the panel. Prefer the translation, fall back to the
 * stored string.
 */
export function resolveModelLabel(
	t: LocaleStrings,
	model: { label: string; labelKey: string | null },
): string {
	return isLocaleKey(model.labelKey, t) ? t[model.labelKey] : model.label;
}

/** Descriptions only ever come from a locale key; null means "no description". */
export function resolveModelDescription(
	t: LocaleStrings,
	model: { descriptionKey: string | null },
): string | null {
	return isLocaleKey(model.descriptionKey, t) ? t[model.descriptionKey] : null;
}

const CAMERA_PROMPT_HINTS: Record<
	Exclude<CameraMovement, "auto" | "fixed">,
	string
> = {
	"zoom-in": "camera slowly pushes in toward the subject",
	"zoom-out": "camera slowly pulls back to reveal the wider scene",
	"pan-left": "camera pans steadily to the left",
	"pan-right": "camera pans steadily to the right",
};

/**
 * Camera direction rides along in the prompt rather than as a request field:
 * it is the one form every provider in the fallback chain understands.
 */
export function applyCameraMovement({
	prompt,
	movement,
}: {
	prompt: string;
	movement: CameraMovement;
}): string {
	if (movement === "auto" || movement === "fixed") {
		return prompt;
	}

	return `${prompt}, ${CAMERA_PROMPT_HINTS[movement]}`;
}

export const CAMERA_MOVEMENTS: {
	value: CameraMovement;
	labelKey: LocaleKey;
}[] = [
	{ value: "auto", labelKey: "ai_video.camera_auto" },
	{ value: "fixed", labelKey: "ai_video.camera_fixed" },
	{ value: "zoom-in", labelKey: "ai_video.camera_zoom_in" },
	{ value: "zoom-out", labelKey: "ai_video.camera_zoom_out" },
	{ value: "pan-left", labelKey: "ai_video.camera_pan_left" },
	{ value: "pan-right", labelKey: "ai_video.camera_pan_right" },
];
