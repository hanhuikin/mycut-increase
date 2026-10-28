import {
	type JobFamily,
	type JobHandle,
	type JobInput,
	type JobState,
	type ListModelsInput,
	type PollCredentials,
	type Protocol,
	type SubmitResult,
	pickFirstString,
	pickPath,
	readJson,
	trimBase,
} from "./types";

const DEFAULT_BASE = "https://queue.fal.run";

/**
 * Video vendors behind the fal queue, each with its own input schema. Qiniu's
 * gateway (api.qnaigc.com) fronts all of them; fal.ai's own queue only ever
 * matches "veo" here today, where the schemas coincide.
 */
type VideoFamily = "veo" | "seedance" | "vidu" | "kling" | "minimax";

function videoFamilyOf(model: string): VideoFamily | undefined {
	if (model.startsWith("fal-ai/veo")) return "veo";
	if (
		model.startsWith("bytedance/seedance") ||
		model.startsWith("byteplus/seedance")
	) {
		return "seedance";
	}
	if (model.startsWith("fal-ai/vidu")) return "vidu";
	if (model.startsWith("fal-ai/kling-video")) return "kling";
	if (model.startsWith("minimax/")) return "minimax";
	return undefined;
}

/**
 * Legacy fal-native mappings spell the mode out (`…/text-to-video`) and are
 * submitted verbatim; the gateway roots carry no mode segment — for those the
 * submit path gains one and the poll URL is derived from the queue root.
 */
function isLegacyVideoModel(model: string): boolean {
	return /\/(text|image|start-end|first-last-frame|reference)-to-video$/.test(
		model,
	);
}

/** Poll URLs live under the queue root: the first two path segments. This
 * matches every gateway status_url checked (veo3.1/fast polls under
 * fal-ai/veo3.1, seedance fast/mini under bytedance/seedance-2.0, vidu tiers
 * under fal-ai/vidu, kling versions under fal-ai/kling-video). */
function pollRootOf(model: string): string {
	return model.split("/").slice(0, 2).join("/");
}

const clamp = (value: number, min: number, max: number): number =>
	Math.min(Math.max(Math.round(value), min), max);

/** Smallest tier ≥ the requested value; the last tier wins otherwise. */
const tier = (value: number, tiers: number[]): number =>
	tiers.find((t) => value <= t) ?? tiers[tiers.length - 1];

/** Per-family submit path: veo nests the mode under the model root; the
 * gateway vendors append the mode to the configured root — except vidu, whose
 * quality tier rides AFTER the mode (`…/q3/text-to-video/turbo`). */
function videoSubmitPath({
	family,
	model,
	imageUrl,
}: {
	family: VideoFamily;
	model: string;
	imageUrl: boolean;
}): string {
	const mode = imageUrl ? "image-to-video" : "text-to-video";
	if (family === "veo") {
		return imageUrl ? `${model}/image-to-video` : model;
	}
	if (family === "vidu") {
		const parts = model.split("/");
		const tierSegment = ["turbo", "pro"].includes(parts[parts.length - 1])
			? parts.pop()
			: undefined;
		return [...parts, mode, ...(tierSegment ? [tierSegment] : [])].join("/");
	}
	return `${model}/${mode}`;
}

/** Veo has no 480p tier; 720p is the closest. */
function veoResolution(resolution: JobInput["resolution"]): string {
	return resolution === "480p" ? "720p" : (resolution ?? "720p");
}

/**
 * Each vendor's body contract, built from the shared JobInput. Only fields
 * the target endpoint actually accepts are emitted — an unknown field 400s
 * and would fall through the whole channel chain for nothing.
 */
function videoBodyFor({
	family,
	input,
}: {
	family: VideoFamily;
	input: JobInput;
}): Record<string, unknown> {
	const prompt = input.prompt ?? "";
	const imageUrl = input.imageUrl;
	const aspect = input.aspectRatio;
	const seconds = input.duration;
	const audio = input.generateAudio;

	if (family === "veo") {
		// Duration is the enum "4s"|"6s"|"8s"; resolution has no 480p tier;
		// aspect only 16:9 / 9:16 (anything else → upstream "auto").
		return {
			prompt,
			...(imageUrl ? { image_url: imageUrl } : {}),
			...(typeof seconds === "number"
				? { duration: `${tier(seconds, [4, 6, 8])}s` }
				: {}),
			resolution: veoResolution(input.resolution),
			...(aspect === "16:9" || aspect === "9:16" ? { aspect_ratio: aspect } : {}),
			...(typeof audio === "boolean" ? { generate_audio: audio } : {}),
		};
	}
	if (family === "seedance") {
		// Duration is a string of integer seconds 4–30 ("auto" → omit);
		// resolution 480p/720p/1080p all exist; aspect accepts the full set.
		return {
			prompt,
			...(imageUrl ? { image_url: imageUrl } : {}),
			...(typeof seconds === "number"
				? { duration: String(clamp(seconds, 4, 30)) }
				: {}),
			resolution: input.resolution ?? "720p",
			...(aspect &&
			["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(aspect)
				? { aspect_ratio: aspect }
				: {}),
			...(typeof audio === "boolean" ? { generate_audio: audio } : {}),
		};
	}
	if (family === "vidu") {
		// Duration is an integer (q3: 3–16); no 480p tier (540p is closest);
		// 4:3 / 3:4 exist only on q2.
		const q2 = /\/q2(\/|$)/.test(input.model);
		return {
			prompt,
			...(imageUrl ? { image_url: imageUrl } : {}),
			...(typeof seconds === "number" ? { duration: clamp(seconds, 3, 16) } : {}),
			resolution:
				input.resolution === "480p" ? "540p" : (input.resolution ?? "720p"),
			...(aspect &&
			(["16:9", "9:16", "1:1"].includes(aspect) ||
				(q2 && (aspect === "4:3" || aspect === "3:4")))
				? { aspect_ratio: aspect }
				: {}),
		};
	}
	if (family === "kling") {
		// Duration is the enum "5" | "10" strings; i2v takes start_image_url and
		// has no resolution / aspect fields at all.
		return {
			prompt,
			...(imageUrl ? { start_image_url: imageUrl } : {}),
			...(typeof seconds === "number"
				? { duration: String(tier(seconds, [5, 10])) }
				: {}),
			...(!imageUrl && aspect && ["16:9", "9:16", "1:1"].includes(aspect)
				? { aspect_ratio: aspect }
				: {}),
			...(typeof audio === "boolean" ? { generate_audio: audio } : {}),
		};
	}
	// minimax: integer seconds 4–15; resolution tiers are "2K" / "768P";
	// i2v drops the aspect field; no audio field exists.
	return {
		prompt,
		...(imageUrl ? { image_url: imageUrl } : {}),
		...(typeof seconds === "number" ? { duration: clamp(seconds, 4, 15) } : {}),
		resolution: input.resolution === "1080p" ? "2K" : "768P",
		...(!imageUrl && aspect ? { aspect_ratio: aspect } : {}),
	};
}

/**
 * fal returns results in a different shape per endpoint — a `video` object for
 * generation, an `images` array for the tools, `audio_url` for musicgen. This
 * is the one place those shapes are reconciled. It is also the reason fal is
 * hand-written rather than described: the result extraction is genuinely
 * variable, and the endpoint doubles as the model name.
 *
 * Qiniu's gateway nests the finished payload under `result` on the *status*
 * endpoint while the plain request endpoint returns it top-level, so every
 * family accepts both depths.
 */
function extractResult(payload: unknown, family: JobFamily): string | undefined {
	if (family === "video") {
		const video = pickFirstString(payload, [
			["result", "video", "url"],
			["video", "url"],
		]);
		if (video) return video;
	} else if (family === "image") {
		const images = (payload as { images?: { url?: string }[] } | null)?.images;
		if (images?.[0]?.url) return images[0].url;
		const resultImages = pickPath(payload, ["result", "images"]);
		if (Array.isArray(resultImages) && resultImages[0]?.url) {
			return resultImages[0].url;
		}
		const image = (payload as { image?: { url?: string } } | null)?.image;
		if (image?.url) return image.url;
	} else if (family === "audio") {
		const audioUrl =
			pickFirstString(payload, [
				["result", "audio_url"],
				["result", "audio_url", "url"],
				["audio_url", "url"],
				["audio_url"],
				["result", "audio", "url"],
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
	// Veo / Seedance / Vidu / Kling / MiniMax honours a start frame (i2v
	// endpoints take an image); fal-native video models don't, but letting them
	// enter the chain only adds a submit that fails — the caller moves down it.
	supportsImageInput: true,
	defaultBaseUrl: DEFAULT_BASE,

	async submit(input: JobInput): Promise<SubmitResult> {
		const base = trimBase(input.baseUrl) || DEFAULT_BASE;
		let path = input.model;
		// Tool and audio callers hand over a ready body. Video splits: gateway
		// roots get a per-family path + body; fal-native models keep the loose
		// legacy body.
		let body: Record<string, unknown>;
		const family =
			input.family === "video" && !isLegacyVideoModel(input.model)
				? videoFamilyOf(input.model)
				: undefined;
		if (input.body) {
			body = input.body;
		} else if (family) {
			path = videoSubmitPath({
				family,
				model: input.model,
				imageUrl: Boolean(input.imageUrl),
			});
			body = videoBodyFor({ family, input });
		} else {
			// fal-native video models: the loose legacy body that always worked.
			body = {
				prompt: input.prompt ?? "",
				duration: input.duration ?? "auto",
				resolution: input.resolution ?? "720p",
			};
		}

		const response = await fetch(`${base}/${path}`, {
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
		// Derived, never caller-supplied — see JobHandle. Gateway video roots
		// poll under the queue root; everything else under the full model path.
		const root =
			handle.family === "video" && !isLegacyVideoModel(handle.model)
				? pollRootOf(handle.model)
				: handle.model;
		const statusUrl = `${base}/${root}/requests/${encodeURIComponent(handle.jobId)}/status`;

		const response = await fetch(statusUrl, {
			headers: { Authorization: `Key ${credentials.apiKey}` },
		});
		if (!response.ok) {
			throw new Error(`fal.ai 轮询失败 (${response.status})`);
		}

		const payload = await readJson(response);
		const status = pickFirstString(payload, [["status"]]) ?? "";
		// Qiniu's gateway reports failures inside an otherwise normal response —
		// the docs note it can arrive even under COMPLETED — so a detail object
		// outranks the status field.
		const detail = pickFirstString(payload, [["detail", "msg"]]);

		if (detail) {
			return { state: "failed", error: `fal.ai: ${detail}` };
		}
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
				`${base}/${root}/requests/${requestId}`,
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

	// fal exposes its model catalogue at GET /models (`Key` auth). It also
	// serves as the connectivity probe: a bad key fails here before any job.
	// Aggregation gateways that proxy the fal queue (Qiniu's api.qnaigc.com)
	// have no /models under /queue — their OpenAI-style catalogue at
	// {origin}/v1/models (Bearer) still proves the key and feeds the probe.
	async listModels(input: ListModelsInput): Promise<string[]> {
		const base = trimBase(input.baseUrl) || DEFAULT_BASE;
		const response = await fetch(`${base}/models`, {
			headers: { Authorization: `Key ${input.apiKey}` },
		});
		if (response.ok) {
			const payload = await readJson(response);
			let list: unknown;
			if (payload && typeof payload === "object" && "models" in payload) {
				list = payload.models;
			}
			if (!Array.isArray(list)) {
				throw new Error(`fal.ai 模型列表返回异常: ${JSON.stringify(payload)}`);
			}
			return list
				.map((entry) => {
					if (typeof entry === "string") return entry;
					if (
						entry &&
						typeof entry === "object" &&
						"name" in entry &&
						typeof entry.name === "string"
					) {
						return entry.name;
					}
					return "";
				})
				.filter((name) => Boolean(name))
				.sort();
		}
		if (response.status !== 404) {
			throw new Error(
				`fal.ai 拉取模型失败 (${response.status}): ${await response.text()}`,
			);
		}
		// Gateway fallback: the OpenAI-style catalogue at the host root.
		const origin = new URL(base).origin;
		const fallback = await fetch(`${origin}/v1/models`, {
			headers: { Authorization: `Bearer ${input.apiKey}` },
		});
		if (!fallback.ok) {
			throw new Error(
				`fal.ai 拉取模型失败 (${fallback.status}): ${await fallback.text()}`,
			);
		}
		const payload = await readJson(fallback);
		let ids: unknown;
		if (payload && typeof payload === "object" && "data" in payload) {
			ids = payload.data;
		}
		if (!Array.isArray(ids)) {
			throw new Error(`fal.ai 模型列表返回异常: ${JSON.stringify(payload)}`);
		}
		return ids
			.map((entry) =>
				entry &&
				typeof entry === "object" &&
				"id" in entry &&
				typeof entry.id === "string"
					? entry.id
					: "",
			)
			.filter(Boolean)
			.sort();
	},
};
