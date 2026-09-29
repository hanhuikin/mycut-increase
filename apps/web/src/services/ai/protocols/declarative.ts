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

/**
 * A JSON protocol described as data.
 *
 * Covers the large family of vendors that share one shape: a POST that returns
 * a job id, and a GET that returns a status plus a result URL. Paths are given
 * as candidate lists, because vendors of the same shape differ in small ways —
 * the id may be `id` or `request_id`, the payload may or may not be wrapped in
 * `data`.
 */
export interface JsonProtocolSpec {
	id: string;
	label: string;
	families: JobFamily[];
	supportsImageInput: boolean;
	defaultBaseUrl: string;
	/** e.g. "Authorization" with prefix "Bearer " or "Key ". */
	authHeader: string;
	authPrefix: string;
	/** Path template; `{model}` is replaced with the upstream model name. */
	submitPath: string;
	/** Path template; `{model}` and `{jobId}` are replaced. */
	pollPath: string;
	submitBody: (input: JobInput) => Record<string, unknown>;
	/** Candidate paths to the job id in the submit response. */
	jobIdPaths: Array<Array<string | number>>;
	/** Candidate paths to the result URL in the poll response. */
	resultPaths: Array<Array<string | number>>;
	doneStatuses: string[];
	failedStatuses: string[];
	/** Candidate paths to an error message. */
	errorPaths?: Array<Array<string | number>>;
}

function fillPath(
	template: string,
	values: { model: string; jobId: string },
): string {
	return template
		.replaceAll("{model}", values.model)
		.replaceAll("{jobId}", encodeURIComponent(values.jobId));
}

/** Builds a Protocol from a spec. See the file comment for what it covers. */
export function defineJsonProtocol(spec: JsonProtocolSpec): Protocol {
	const auth = (apiKey: string) => ({
		[spec.authHeader.toLowerCase()]: `${spec.authPrefix}${apiKey}`,
	});

	return {
		id: spec.id,
		label: spec.label,
		families: spec.families,
		supportsImageInput: spec.supportsImageInput,
		defaultBaseUrl: spec.defaultBaseUrl,

		async submit(input: JobInput): Promise<SubmitResult> {
			const base = trimBase(input.baseUrl) || spec.defaultBaseUrl;
			const response = await fetch(
				`${base}${fillPath(spec.submitPath, { model: input.model, jobId: "" })}`,
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...auth(input.apiKey),
					},
					body: JSON.stringify(spec.submitBody(input)),
				},
			);

			if (!response.ok) {
				throw new Error(
					`${spec.label} 请求失败 (${response.status}): ${await response.text()}`,
				);
			}

			const payload = await readJson(response);
			const jobId = pickFirstString(payload, spec.jobIdPaths);
			if (!jobId) {
				throw new Error(`${spec.label} 返回异常: ${JSON.stringify(payload)}`);
			}
			return { jobId };
		},

		async poll(
			handle: JobHandle,
			credentials: PollCredentials,
		): Promise<JobState> {
			const base = trimBase(handle.baseUrl) || spec.defaultBaseUrl;
			const response = await fetch(
				`${base}${fillPath(spec.pollPath, {
					model: handle.model,
					jobId: handle.jobId,
				})}`,
				{ headers: auth(credentials.apiKey) },
			);
			if (!response.ok) {
				throw new Error(`${spec.label} 轮询失败 (${response.status})`);
			}

			const payload = await readJson(response);
			const status = pickFirstString(payload, [["status"]]) ?? "";

			if (spec.doneStatuses.includes(status)) {
				const url = pickFirstString(payload, spec.resultPaths);
				return url
					? { state: "done", url }
					: { state: "failed", error: `${spec.label} 返回了空地址` };
			}
			if (spec.failedStatuses.includes(status)) {
				const detail =
					spec.errorPaths && pickFirstString(payload, spec.errorPaths);
				return {
					state: "failed",
					error: `${spec.label}: ${detail ?? "生成失败"}`,
				};
			}
			return { state: "pending" };
		},
	};
}
