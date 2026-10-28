import {
	type GenerateImageInput,
	type GenerateImageResult,
	type JobHandle,
	type JobInput,
	type JobState,
	type ListModelsInput,
	type PollCredentials,
	type Protocol,
	type SubmitResult,
	readJson,
	trimBase,
} from "./types";

const DEFAULT_BASE = "https://api.modelink.ai/v1";

/**
 * 七牛海外 Modelink — an OpenAI-compatible aggregation endpoint.
 *
 * Two shapes live here:
 * - Synchronous image generation (`POST /images/generations` returns the
 *   finished pictures directly, `b64_json` or `url`).
 * - Async video generation (`POST /videos/generations` with a Gemini-style
 *   `instances` body returns a job id, polled at
 *   `GET /videos/generations/{id}` — veo models only).
 */
export const modelinkProtocol: Protocol = {
	id: "modelink",
	label: "七牛 Modelink",
	families: ["video", "image"],
	supportsImageInput: false,
	defaultBaseUrl: DEFAULT_BASE,

	// OpenAI-compatible catalogue; doubles as the connectivity probe.
	async listModels(input: ListModelsInput): Promise<string[]> {
		const base = trimBase(input.baseUrl) || DEFAULT_BASE;
		const response = await fetch(`${base}/models`, {
			headers: { Authorization: `Bearer ${input.apiKey}` },
		});
		if (!response.ok) {
			throw new Error(
				`Modelink 拉取模型失败 (${response.status}): ${await response.text()}`,
			);
		}
		const payload = await readJson(response);
		let list: unknown;
		if (payload && typeof payload === "object" && "data" in payload) {
			list = payload.data;
		}
		if (!Array.isArray(list)) {
			throw new Error(`Modelink 模型列表返回异常: ${JSON.stringify(payload)}`);
		}
		return list
			.map((entry) =>
				entry &&
				typeof entry === "object" &&
				"id" in entry &&
				typeof entry.id === "string"
					? entry.id
					: "",
			)
			.filter((id) => Boolean(id))
			.sort();
	},

	async generateImage(input: GenerateImageInput): Promise<GenerateImageResult> {
		const base = trimBase(input.baseUrl) || DEFAULT_BASE;
		const response = await fetch(`${base}/images/generations`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${input.apiKey}`,
			},
			body: JSON.stringify({
				model: input.model,
				prompt: input.prompt,
				n: input.count,
				size: input.size,
			}),
		});
		if (!response.ok) {
			throw new Error(
				`Modelink 生图失败 (${response.status}): ${await response.text()}`,
			);
		}
		const payload = await readJson(response);
		let items: unknown;
		if (payload && typeof payload === "object" && "data" in payload) {
			items = payload.data;
		}
		if (!Array.isArray(items)) {
			throw new Error(`Modelink 生图返回异常: ${JSON.stringify(payload)}`);
		}
		const dataUrls: string[] = [];
		for (const item of items) {
			if (!item || typeof item !== "object") continue;
			if ("b64_json" in item && typeof item.b64_json === "string") {
				dataUrls.push(`data:image/png;base64,${item.b64_json}`);
			} else if ("url" in item && typeof item.url === "string") {
				dataUrls.push(item.url);
			}
		}
		if (dataUrls.length === 0) {
			throw new Error(`Modelink 生图返回了空结果: ${JSON.stringify(payload)}`);
		}
		return { dataUrls };
	},

	// Async video generation: Gemini-style `instances` body, veo models only.
	async submit(input: JobInput): Promise<SubmitResult> {
		const base = trimBase(input.baseUrl) || DEFAULT_BASE;
		const generationConfig: Record<string, unknown> = {};
		if (typeof input.duration === "number" && input.duration > 0) {
			generationConfig["durationSeconds"] = Math.round(input.duration);
		}
		const response = await fetch(`${base}/videos/generations`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${input.apiKey}`,
			},
			body: JSON.stringify({
				model: input.model,
				instances: [{ prompt: input.prompt ?? "" }],
				...(Object.keys(generationConfig).length > 0
					? { generationConfig }
					: {}),
			}),
		});
		if (!response.ok) {
			throw new Error(
				`Modelink 视频提交失败 (${response.status}): ${await response.text()}`,
			);
		}
		const payload = await readJson(response);
		let jobId: string | undefined;
		if (payload && typeof payload === "object" && "id" in payload) {
			jobId = typeof payload.id === "string" ? payload.id : undefined;
		}
		if (!jobId) {
			throw new Error(`Modelink 视频提交返回异常: ${JSON.stringify(payload)}`);
		}
		return { jobId };
	},

	// eslint-disable-next-line opencut/prefer-object-params -- signature is fixed by the Protocol interface
	async poll(handle: JobHandle, credentials: PollCredentials): Promise<JobState> {
		const base = trimBase(handle.baseUrl) || DEFAULT_BASE;
		const response = await fetch(
			`${base}/videos/generations/${encodeURIComponent(handle.jobId)}`,
			{ headers: { Authorization: `Bearer ${credentials.apiKey}` } },
		);
		if (!response.ok) {
			throw new Error(`Modelink 视频轮询失败 (${response.status})`);
		}
		const payload = await readJson(response);
		let status = "";
		if (payload && typeof payload === "object" && "status" in payload) {
			status = typeof payload.status === "string" ? payload.status : "";
		}
		const normalized = status.toLowerCase();

		if (
			normalized === "completed" ||
			normalized === "succeeded" ||
			normalized === "success"
		) {
			let url: string | undefined;
			if (payload && typeof payload === "object" && "data" in payload) {
				const data = payload.data;
				if (data && typeof data === "object" && "videos" in data) {
					const videos = data.videos;
					if (Array.isArray(videos)) {
						const first = videos[0];
						if (typeof first === "string") {
							url = first;
						} else if (
							first &&
							typeof first === "object" &&
							"url" in first &&
							typeof first.url === "string"
						) {
							url = first.url;
						}
					}
				}
			}
			return url
				? { state: "done", url }
				: { state: "failed", error: "Modelink 返回了空视频地址" };
		}
		if (normalized === "failed" || normalized === "error") {
			let message = "";
			if (payload && typeof payload === "object" && "message" in payload) {
				message = typeof payload.message === "string" ? payload.message : "";
			}
			return {
				state: "failed",
				error: `Modelink: ${message || "生成失败"}`,
			};
		}
		return { state: "pending" };
	},
};
