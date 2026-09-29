import {
	type JobHandle,
	type JobInput,
	type JobState,
	type PollCredentials,
	type Protocol,
	type SubmitResult,
	pickFirstString,
	readJson,
	trimBase,
} from "./types";

const DEFAULT_BASE = "https://ark.cn-beijing.volces.com/api/v3";
/** Ark's own default, used when a channel maps no upstream name. */
const DEFAULT_MODEL = "doubao-seedance-2-0-260128";

type ArkContentPart =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string } };

/**
 * Volcano Ark: a bespoke shape. The body is a `content` array rather than flat
 * fields, the job id is at the top level, and the result sits at
 * `content.video_url` — none of which the JSON description covers.
 */
export const arkProtocol: Protocol = {
	id: "ark",
	label: "火山方舟",
	families: ["video"],
	supportsImageInput: true,
	defaultBaseUrl: DEFAULT_BASE,

	async submit(input: JobInput): Promise<SubmitResult> {
		const base = trimBase(input.baseUrl) || DEFAULT_BASE;

		const content: ArkContentPart[] = [
			{ type: "text", text: input.prompt ?? "" },
		];
		if (input.imageUrl) {
			content.push({
				type: "image_url",
				image_url: { url: input.imageUrl },
			});
		}

		const response = await fetch(`${base}/contents/generations/tasks`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${input.apiKey}`,
			},
			body: JSON.stringify({
				model: input.model || DEFAULT_MODEL,
				content,
				ratio: input.aspectRatio || "16:9",
				...(input.duration !== undefined && input.duration !== "auto"
					? { duration: Number(input.duration) }
					: {}),
				resolution: input.resolution || "720p",
				generate_audio: input.generateAudio ?? false,
			}),
		});

		if (!response.ok) {
			throw new Error(
				`火山方舟请求失败 (${response.status}): ${await response.text()}`,
			);
		}

		const payload = await readJson(response);
		const jobId = pickFirstString(payload, [["id"]]);
		if (!jobId) {
			throw new Error(`火山方舟返回异常: ${JSON.stringify(payload)}`);
		}
		return { jobId };
	},

	async poll(
		handle: JobHandle,
		credentials: PollCredentials,
	): Promise<JobState> {
		const base = trimBase(handle.baseUrl) || DEFAULT_BASE;
		const response = await fetch(
			`${base}/contents/generations/tasks/${encodeURIComponent(handle.jobId)}`,
			{ headers: { Authorization: `Bearer ${credentials.apiKey}` } },
		);
		if (!response.ok) {
			throw new Error(`火山方舟轮询失败 (${response.status})`);
		}

		const payload = await readJson(response);
		const status = pickFirstString(payload, [["status"]]) ?? "";

		if (status === "succeeded" || status === "completed") {
			const url = pickFirstString(payload, [["content", "video_url"]]);
			return url
				? { state: "done", url }
				: { state: "failed", error: "火山方舟返回了空视频地址" };
		}
		if (status === "failed" || status === "cancelled") {
			const message =
				pickFirstString(payload, [["error", "message"], ["error"]]) ??
				"未知错误";
			return { state: "failed", error: `火山方舟: ${message}` };
		}
		return { state: "pending" };
	},
};
