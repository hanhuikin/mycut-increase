import { Command, type CommandResult } from "@/commands/base-command";
import type { OverlayTrack, SceneTracks, TrackType } from "@/timeline";
import { generateUUID } from "@/utils/id";
import { EditorCore } from "@/core";
import {
	buildEmptyTrack,
	getDefaultInsertIndexForTrack,
} from "@/timeline/placement";

export class AddTrackCommand extends Command {
	private trackId: string;
	private savedState: SceneTracks | null = null;

	constructor({
		type,
		index,
	}: {
		type: TrackType;
		index?: number;
	}) {
		super();
		this.type = type;
		this.index = index;
		this.trackId = generateUUID();
	}

	private type: TrackType;
	private index?: number;

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		this.savedState = editor.scenes.getActiveScene().tracks;

		const insertIndex =
			this.index ??
			getDefaultInsertIndexForTrack({
				tracks: this.savedState,
				trackType: this.type,
			});

		const updatedTracks =
			this.type === "audio"
				? buildAudioTrackState({
						tracks: this.savedState,
						insertIndex,
						trackId: this.trackId,
					})
				: buildOverlayTrackState({
						tracks: this.savedState,
						insertIndex,
						trackId: this.trackId,
						trackType: this.type,
					});

		editor.timeline.updateTracks(updatedTracks);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			const editor = EditorCore.getInstance();
			editor.timeline.updateTracks(this.savedState);
		}
	}

	getTrackId(): string {
		return this.trackId;
	}
}

function buildAudioTrackState({
	tracks,
	insertIndex,
	trackId,
}: {
	tracks: SceneTracks;
	insertIndex: number;
	trackId: string;
}): SceneTracks {
	const audioInsertIndex = Math.max(0, insertIndex - tracks.overlay.length - 1);
	const newTrack = buildEmptyTrack({
		id: trackId,
		type: "audio",
	});
	return {
		...tracks,
		audio: [
			...tracks.audio.slice(0, audioInsertIndex),
			newTrack,
			...tracks.audio.slice(audioInsertIndex),
		],
	};
}

function buildOverlayTrackState({
	tracks,
	insertIndex,
	trackId,
	trackType,
}: {
	tracks: SceneTracks;
	insertIndex: number;
	trackId: string;
	trackType: Exclude<TrackType, "audio">;
}): SceneTracks {
	const overlayInsertIndex = Math.min(insertIndex, tracks.overlay.length);
	// 显式 switch 而不是三元链：新增轨道类型时漏写分支会直接编译报错，
	// 三元链的兜底分支会把新类型静默建成 effect 轨道。
	const buildTrack = (): OverlayTrack => {
		switch (trackType) {
			case "video":
				return buildEmptyTrack({ id: trackId, type: "video" });
			case "text":
				return buildEmptyTrack({ id: trackId, type: "text" });
			case "graphic":
				return buildEmptyTrack({ id: trackId, type: "graphic" });
			case "effect":
				return buildEmptyTrack({ id: trackId, type: "effect" });
			case "transition":
				return buildEmptyTrack({ id: trackId, type: "transition" });
		}
	};
	const newTrack = buildTrack();
	return {
		...tracks,
		overlay: [
			...tracks.overlay.slice(0, overlayInsertIndex),
			newTrack,
			...tracks.overlay.slice(overlayInsertIndex),
		],
	};
}
