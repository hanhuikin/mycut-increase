import {
	type JobFamily,
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

const DEFAULT_BASE = "https://queue.fal.run";

/**
 * fal returns results in a different shape per endpoint — a `video` object for
 * generation, an `images` array for the tools, `audio_url` for musicgen. This
 * is the one place those shapes are reconciled. It is also the reason fal is
 * hand-written rather than described: the result extraction is genuinely
 * variable, and the endpoint doubles as the model name.
 */
function extractResult(payload: unknown, family: JobFamily): string | undefined {
	if (family === "video") {
		const video = pickFirstString(payload, [["video", "url"]]);
		if (video) return video;
	} else if (family === "image") {
		const images = (payload as { images?: { url?: string }[] } | null)?.images;
		if (images?.[0]?.url) return images[0].url;
		const image = (payload as { image?: { url?: string } } | null)?.image;
		if (image?.url) return image.url;
	} else if (family === "audio") {
		const audioUrl =
			pickFirstString(payload, [
				["audio_url", "url"],
				["audio_url"],
				["audio", "url"],
			]) ?? undefined;
		if (audioUrl) return audioUrl;
	}

	// Generic string fallbacks, shared by every family.
	const output = pickFirstString(payload, [["output"]]);
	if (output?.startsWith("http")) return output;
	const result = pickFirstString(payload, [["result"]]);
	return result?.startsWith("http") ? result : undefined;
}

/**
 * fal.ai's queue protocol, shared by video generation, the image tools and
 * audio generation — only the endpoint path differs.
 */
export const falProtocol: Protocol = {
	id: "fal-queue",
	label: "fal.ai",
	families: ["video", "image", "audio"],
	supportsImageInput: false,
	defaultBaseUrl: DEFAULT_BASE,

	async submit(input: JobInput): Promise<SubmitResult> {
		const base = trimBase(input.baseUrl) || DEFAULT_BASE;
		// Tool and audio callers hand over a ready body; video gets the standard one.
		const body = input.body ?? {
			prompt: input.prompt ?? "",
			duration: input.duration ?? "auto",
			resolution: input.resolution ?? "720p",
		};

		const response = await fetch(`${base}/${input.model}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Key ${input.apiKey}`,
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			throw new Error(
				`fal.ai 请求失败 (${response.status}): ${await response.text()}`,
			);
		}

		const payload = await readJson(response);
		// fal normally returns request_id; fall back to pulling it out of the
		// status URL so a job is never lost just because the id moved.
		const jobId =
			pickFirstString(payload, [["request_id"]]) ??
			pickFirstString(payload, [["status_url"]])?.match(/requests\/([^/]+)/)?.[1] ??
			"";
		if (!jobId) {
			throw new Error(`fal.ai 返回异常: ${JSON.stringify(payload)}`);
		}
		return { jobId };
	},

	async poll(
		handle: JobHandle,
		credentials: PollCredentials,
	): Promise<JobState> {
		const base = trimBase(handle.baseUrl) || DEFAULT_BASE;
		// Derived, never caller-supplied — see JobHandle.
		const statusUrl = `${base}/${handle.model}/requests/${encodeURIComponent(handle.jobId)}/status`;

		const response = await fetch(statusUrl, {
			headers: { Authorization: `Key ${credentials.apiKey}` },
		});
		if (!response.ok) {
			throw new Error(`fal.ai 轮询失败 (${response.status})`);
		}

		const payload = await readJson(response);
		const status = pickFirstString(payload, [["status"]]) ?? "";

		if (status === "FAILED") {
			return { state: "failed", error: "fal.ai 生成失败" };
		}
		if (status !== "COMPLETED") {
			return { state: "pending" };
		}

		// Most endpoints return the result inline once complete.
		const inline = extractResult(payload, handle.family);
		if (inline) {
			return { state: "done", url: inline };
		}

		// Otherwise re-fetch the request result.
		const requestId = pickFirstString(payload, [["request_id"]]) ?? handle.jobId;
		if (requestId) {
			const resultResponse = await fetch(
				`${base}/${handle.model}/requests/${requestId}`,
				{ headers: { Authorization: `Key ${credentials.apiKey}` } },
			);
			if (resultResponse.ok) {
				const found = extractResult(
					await readJson(resultResponse),
					handle.family,
				);
				if (found) return { state: "done", url: found };
			}
		}

		// Last resort: `response_url` is either a JSON result or a presigned file.
		const responseUrl = pickFirstString(payload, [["response_url"]]);
		if (responseUrl) {
			const fileResponse = await fetch(responseUrl, {
				headers: { Authorization: `Key ${credentials.apiKey}` },
			}).catch(() => null);
			if (fileResponse?.ok) {
				const found = extractResult(
					await readJson(fileResponse),
					handle.family,
				);
				if (found) return { state: "done", url: found };
			}
			if (responseUrl.startsWith("http") && !responseUrl.includes("fal.run")) {
				return { state: "done", url: responseUrl };
			}
		}

		return { state: "failed", error: "fal.ai 任务完成但未找到结果文件" };
	},
};
