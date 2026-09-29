import {
	type ChannelInput,
	isValidBaseUrl,
} from "@/services/admin/channels";
import { getModel } from "@/services/admin/models";
import { isProtocolId } from "@/services/ai/protocols";

/**
 * Validates a channel payload.
 *
 * Lives outside the route file (Next allows only handler exports there) and
 * outside `channels.ts` itself (which `models.ts` imports, so reaching back for
 * `getModel` would be a cycle).
 *
 * Model keys must be real model ids: a mapping to a typo would silently never
 * match, which reads as "the channel is configured but nothing routes" — worth
 * refusing up front.
 */
export async function parseChannelInput(
	body: unknown,
): Promise<{ ok: true; input: ChannelInput } | { ok: false; error: string }> {
	const source = body as {
		name?: unknown;
		protocol?: unknown;
		baseUrl?: unknown;
		apiKey?: unknown;
		models?: unknown;
		priority?: unknown;
		enabled?: unknown;
	};

	const name = typeof source.name === "string" ? source.name.trim() : "";
	if (!name) return { ok: false, error: "name_required" };

	const protocol = typeof source.protocol === "string" ? source.protocol : "";
	if (!isProtocolId(protocol)) return { ok: false, error: "unknown_protocol" };

	const baseUrl =
		typeof source.baseUrl === "string" ? source.baseUrl.trim() : "";
	if (!isValidBaseUrl(baseUrl)) return { ok: false, error: "invalid_base_url" };

	const apiKey = typeof source.apiKey === "string" ? source.apiKey : "";

	if (
		typeof source.models !== "object" ||
		source.models === null ||
		Array.isArray(source.models)
	) {
		return { ok: false, error: "models_required" };
	}
	const models: Record<string, string> = {};
	for (const [modelId, upstream] of Object.entries(
		source.models as Record<string, unknown>,
	)) {
		if (typeof upstream !== "string" || !upstream.trim()) {
			return { ok: false, error: `models.${modelId} must be a name` };
		}
		if (!(await getModel({ id: modelId }))) {
			return { ok: false, error: `unknown_model: ${modelId}` };
		}
		models[modelId] = upstream.trim();
	}

	const priority =
		typeof source.priority === "number" && Number.isFinite(source.priority)
			? Math.round(source.priority)
			: 0;

	return {
		ok: true,
		input: {
			name,
			protocol,
			baseUrl,
			apiKey,
			models,
			priority,
			enabled: source.enabled !== false,
		},
	};
}
