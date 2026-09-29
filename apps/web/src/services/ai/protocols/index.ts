import { arkProtocol } from "./ark";
import { defineJsonProtocol } from "./declarative";
import { falProtocol } from "./fal";
import {
	type JobFamily,
	type Protocol,
	JOB_FAMILIES,
} from "./types";

/**
 * Atlas Cloud — a plain JSON submit/poll vendor: model in the body, job id at
 * `data.id`, results at `data.outputs[0]`.
 */
const atlasProtocol = defineJsonProtocol({
	id: "atlas",
	label: "Atlas Cloud",
	families: ["video"],
	supportsImageInput: false,
	defaultBaseUrl: "https://api.atlascloud.ai/api/v1",
	authHeader: "Authorization",
	authPrefix: "Bearer ",
	submitPath: "/model/generateVideo",
	pollPath: "/model/prediction/{jobId}",
	submitBody: (input) => ({
		model: input.model,
		prompt: input.prompt ?? "",
		duration: input.duration ?? "auto",
		resolution: input.resolution ?? "720p",
		ratio: input.aspectRatio ?? "16:9",
		generate_audio: input.generateAudio ?? false,
		watermark: false,
	}),
	jobIdPaths: [["data", "id"]],
	resultPaths: [
		["data", "outputs", 0],
		["outputs", 0],
	],
	doneStatuses: ["completed", "succeeded"],
	failedStatuses: ["failed"],
	errorPaths: [["data", "error"], ["error"]],
});

/**
 * WaveSpeedAI — the same shape as Atlas, except the model sits in the path and
 * the payload is wrapped in `data`. This is the pair that motivated describing
 * protocols as data instead of hand-writing each one.
 */
const wavespeedProtocol = defineJsonProtocol({
	id: "wavespeed",
	label: "WaveSpeedAI",
	families: ["video"],
	supportsImageInput: false,
	defaultBaseUrl: "https://api.wavespeed.ai/api/v3",
	authHeader: "Authorization",
	authPrefix: "Bearer ",
	submitPath: "/{model}",
	pollPath: "/predictions/{jobId}/result",
	submitBody: (input) => ({
		prompt: input.prompt ?? "",
		duration: input.duration ?? "auto",
		// This endpoint has no 480p tier; the closest is 720p.
		resolution:
			input.resolution === "480p" ? "720p" : (input.resolution ?? "720p"),
		aspect_ratio: input.aspectRatio ?? "16:9",
		generate_audio: input.generateAudio ?? false,
	}),
	jobIdPaths: [["id"], ["request_id"]],
	resultPaths: [
		["data", "outputs", 0],
		["outputs", 0],
	],
	doneStatuses: ["completed"],
	failedStatuses: ["failed"],
});

/** Every protocol a channel can be configured with, in display order. */
export const PROTOCOLS: Protocol[] = [
	arkProtocol,
	falProtocol,
	atlasProtocol,
	wavespeedProtocol,
];

export function getProtocol(id: string): Protocol | undefined {
	return PROTOCOLS.find((protocol) => protocol.id === id);
}

export function isProtocolId(id: string): boolean {
	return PROTOCOLS.some((protocol) => protocol.id === id);
}

/** Protocols that can produce a given job family. */
export function protocolsForFamily(family: JobFamily): Protocol[] {
	return PROTOCOLS.filter((protocol) => protocol.families.includes(family));
}

/** Protocol metadata for the channel editor's type picker. */
export function protocolOptions(): Array<{
	id: string;
	label: string;
	families: JobFamily[];
	supportsImageInput: boolean;
	defaultBaseUrl: string;
}> {
	return PROTOCOLS.map((protocol) => ({
		id: protocol.id,
		label: protocol.label,
		families: protocol.families,
		supportsImageInput: protocol.supportsImageInput,
		defaultBaseUrl: protocol.defaultBaseUrl,
	}));
}

export { JOB_FAMILIES };
export type {
	JobFamily,
	JobHandle,
	JobInput,
	JobState,
	PollCredentials,
	Protocol,
	Resolution,
	SubmitResult,
} from "./types";
export { isJobFamily } from "./types";
