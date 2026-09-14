import type { ShortcutKey } from "@/actions/keybinding";
import type { LocaleKey } from "@/locale";
import type { TActionWithOptionalArgs } from "./types";

export type TActionCategory =
	| "playback"
	| "navigation"
	| "editing"
	| "selection"
	| "history"
	| "timeline"
	| "controls"
	| "assets";

export interface TActionBaseDefinition {
	descriptionKey: LocaleKey;
	category: TActionCategory;
	args?: Record<string, unknown>;
}

export interface TActionDefinition extends TActionBaseDefinition {
	defaultShortcuts?: readonly ShortcutKey[];
}

export const ACTIONS = {
	"toggle-play": {
		descriptionKey: "action.toggle_play",
		category: "playback",
	},
	"stop-playback": {
		descriptionKey: "action.stop_playback",
		category: "playback",
	},
	"seek-forward": {
		descriptionKey: "action.seek_forward",
		category: "playback",
		args: { seconds: "number" },
	},
	"seek-backward": {
		descriptionKey: "action.seek_backward",
		category: "playback",
		args: { seconds: "number" },
	},
	"frame-step-forward": {
		descriptionKey: "action.frame_step_forward",
		category: "navigation",
	},
	"frame-step-backward": {
		descriptionKey: "action.frame_step_backward",
		category: "navigation",
	},
	"jump-forward": {
		descriptionKey: "action.jump_forward",
		category: "navigation",
		args: { seconds: "number" },
	},
	"jump-backward": {
		descriptionKey: "action.jump_backward",
		category: "navigation",
		args: { seconds: "number" },
	},
	"goto-start": {
		descriptionKey: "action.goto_start",
		category: "navigation",
	},
	"goto-end": {
		descriptionKey: "action.goto_end",
		category: "navigation",
	},
	split: {
		descriptionKey: "action.split",
		category: "editing",
	},
	"split-left": {
		descriptionKey: "action.split_left",
		category: "editing",
	},
	"split-right": {
		descriptionKey: "action.split_right",
		category: "editing",
	},
	"delete-selected": {
		descriptionKey: "action.delete_selected",
		category: "editing",
	},
	"copy-selected": {
		descriptionKey: "action.copy_selected",
		category: "editing",
	},
	"paste-copied": {
		descriptionKey: "action.paste_copied",
		category: "editing",
	},
	"toggle-snapping": {
		descriptionKey: "action.toggle_snapping",
		category: "editing",
	},
	"toggle-ripple-editing": {
		descriptionKey: "action.toggle_ripple_editing",
		category: "editing",
	},
	"toggle-source-audio": {
		descriptionKey: "action.toggle_source_audio",
		category: "editing",
	},
	"select-all": {
		descriptionKey: "action.select_all",
		category: "selection",
	},
	"cancel-interaction": {
		descriptionKey: "action.cancel_interaction",
		category: "controls",
	},
	"deselect-all": {
		descriptionKey: "action.deselect_all",
		category: "selection",
	},
	"duplicate-selected": {
		descriptionKey: "action.duplicate_selected",
		category: "selection",
	},
	"toggle-elements-muted-selected": {
		descriptionKey: "action.toggle_muted",
		category: "selection",
	},
	"toggle-elements-visibility-selected": {
		descriptionKey: "action.toggle_visibility",
		category: "selection",
	},
	"toggle-bookmark": {
		descriptionKey: "action.toggle_bookmark",
		category: "timeline",
	},
	undo: {
		descriptionKey: "action.undo",
		category: "history",
	},
	redo: {
		descriptionKey: "action.redo",
		category: "history",
	},
	"remove-media-asset": {
		descriptionKey: "action.remove_media_asset",
		category: "assets",
		args: { projectId: "string", assetId: "string" },
	},
	"remove-media-assets": {
		descriptionKey: "action.remove_media_assets",
		category: "assets",
		args: { projectId: "string", assetIds: "string[]" },
	},
} as const satisfies Record<string, TActionBaseDefinition>;

export type TAction = keyof typeof ACTIONS;

const ACTION_DEFAULT_SHORTCUTS = [
	["toggle-play", ["space", "k"]],
	["seek-forward", ["l"]],
	["seek-backward", ["j"]],
	["frame-step-forward", ["right"]],
	["frame-step-backward", ["left"]],
	["jump-forward", ["shift+right"]],
	["jump-backward", ["shift+left"]],
	["goto-start", ["home", "enter"]],
	["goto-end", ["end"]],
	["split", ["s"]],
	["split-left", ["q"]],
	["split-right", ["w"]],
	["delete-selected", ["backspace", "delete"]],
	["copy-selected", ["ctrl+c"]],
	["paste-copied", ["ctrl+v"]],
	["toggle-snapping", ["n"]],
	["select-all", ["ctrl+a"]],
	["cancel-interaction", ["escape"]],
	["duplicate-selected", ["ctrl+d"]],
	["undo", ["ctrl+z"]],
	["redo", ["ctrl+shift+z", "ctrl+y"]],
] as const satisfies ReadonlyArray<
	readonly [TActionWithOptionalArgs, readonly ShortcutKey[]]
>;

const ACTION_DEFAULT_SHORTCUTS_BY_ACTION = new Map<
	TAction,
	readonly ShortcutKey[]
>(ACTION_DEFAULT_SHORTCUTS);

export function getActionDefinition({
	action,
}: {
	action: TAction;
}): TActionDefinition {
	return {
		...ACTIONS[action],
		defaultShortcuts: ACTION_DEFAULT_SHORTCUTS_BY_ACTION.get(action),
	};
}

export function getDefaultShortcuts(): Map<
	ShortcutKey,
	TActionWithOptionalArgs
> {
	const shortcuts = new Map<ShortcutKey, TActionWithOptionalArgs>();

	for (const [action, defaultShortcuts] of ACTION_DEFAULT_SHORTCUTS) {
		for (const shortcut of defaultShortcuts) {
			shortcuts.set(shortcut, action);
		}
	}

	return shortcuts;
}
