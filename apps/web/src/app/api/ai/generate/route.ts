import { type NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/auth/guard";
import { estimateModelCost, getModel, hasModelGrant } from "@/services/admin/models";
import {
	familyForKind,
	resolveChannelChain,
} from "@/services/admin/channels";
import {
	countFreezesToday,
	freezeForTask,
	getBalance,
	hasFrozenRef,
	LedgerError,
	refundTask,
} from "@/services/billing/ledger";

const RESOLUTIONS: readonly string[] = ["480p", "720p", "1080p"];

function parseResolution(value: unknown): "480p" | "720p" | "1080p" | undefined {
	return typeof value === "string" && RESOLUTIONS.includes(value)
		? (value as "480p" | "720p" | "1080p")
		: undefined;
}

function parseDuration(value: unknown): number | "auto" | undefined {
	if (value === "auto") return "auto";
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? value
		: undefined;
}

/** Seconds to bill for: what was asked, clamped to the model's own ceiling. */
function billableSeconds({
	requested,
	maxDuration,
}: {
	requested: number | "auto" | undefined;
	maxDuration: number;
}): number {
	const seconds = typeof requested === "number" ? Math.round(requested) : 5;
	return Math.min(Math.max(seconds, 1), maxDuration);
}

/**
 * Submit a job, returning an opaque handle to poll with.
 *
 * Costs points, so it needs an account: the estimate is frozen here, server-side,
 * against the caller's `refId`, and given back if no channel accepts the job. A
 * guest cannot reach this — nor can a caller dodge the charge by talking to the
 * route directly, which is why the freeze lives here rather than in the panel.
 *
 * What stays server-side is the channel configuration — keys, endpoints and the
 * model→upstream mapping. Channels are tried in priority order and the first one
 * to accept wins. A caller that saw a *poll* fail retries with `exclude` (and a
 * fresh `refId`) to move down the chain.
 */
export async function POST(request: NextRequest) {
	const user = await getSessionUser();
	if (!user) {
		return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
	}

	let raw: Record<string, unknown>;
	try {
		raw = (await request.json()) as Record<string, unknown>;
	} catch {
		return NextResponse.json({ error: "invalid_json" }, { status: 400 });
	}

	const modelId = typeof raw.modelId === "string" ? raw.modelId : "";
	const model = modelId ? await getModel({ id: modelId }) : null;
	if (!model || !model.enabled) {
		return NextResponse.json({ error: "model_unavailable" }, { status: 404 });
	}

	// The freeze is keyed on this, and a replay of the same key would book no
	// second charge — so a ref is usable exactly once.
	const refId = typeof raw.refId === "string" ? raw.refId : "";
	if (!refId) {
		return NextResponse.json({ error: "refId_required" }, { status: 400 });
	}
	if (await hasFrozenRef({ refId })) {
		return NextResponse.json({ error: "refId_reused" }, { status: 409 });
	}

	if (
		model.requiresPro &&
		user.plan !== "pro" &&
		!(await hasModelGrant({ userId: user.id, modelId: model.id }))
	) {
		return NextResponse.json({ error: "pro_required" }, { status: 403 });
	}

	const family = familyForKind(model.kind);
	if (!family) {
		// `local` models run in the browser and must never reach the server.
		return NextResponse.json({ error: "model_not_remote" }, { status: 400 });
	}

	const duration = parseDuration(raw.duration);
	const resolution = parseResolution(raw.resolution) ?? "720p";
	const seconds = billableSeconds({ requested: duration, maxDuration: model.maxDuration });
	const cost = estimateModelCost({ model, resolution, seconds });

	if (model.dailyLimit != null) {
		const usedToday = await countFreezesToday({
			userId: user.id,
			modelId: model.id,
		});
		if (usedToday >= model.dailyLimit) {
			return NextResponse.json({ error: "daily_limit" }, { status: 429 });
		}
	}

	const imageUrl = typeof raw.imageUrl === "string" ? raw.imageUrl : undefined;
	const chain = await resolveChannelChain({
		modelId: model.id,
		kind: model.kind,
		imageUrl,
	});
	const excluded = new Set(
		(Array.isArray(raw.exclude) ? raw.exclude : []).filter(
			(value): value is string => typeof value === "string",
		),
	);
	const attempts = chain.filter((routed) => !excluded.has(routed.channel.id));
	if (attempts.length === 0) {
		return NextResponse.json(
			{ error: "no_channel_available" },
			{ status: 503 },
		);
	}

	if (cost > 0) {
		try {
			await freezeForTask({
				userId: user.id,
				refId,
				amount: cost,
				note: `${model.label} ${resolution} ${seconds}s`,
				modelId: model.id,
				seconds,
			});
		} catch (error) {
			if (error instanceof LedgerError && error.code === "insufficient") {
				return NextResponse.json(
					{
						error: "insufficient",
						cost,
						balance: await getBalance({ userId: user.id }),
					},
					{ status: 402 },
				);
			}
			throw error;
		}
	}

	// A verbatim body is honoured only for tool/audio jobs. `model` is stripped
	// so a caller cannot redirect the job away from its routed endpoint.
	const passthrough =
		family !== "video" && typeof raw.input === "object" && raw.input !== null
			? { ...(raw.input as Record<string, unknown>) }
			: undefined;
	if (passthrough) {
		delete passthrough.model;
	}

	const failures: string[] = [];
	for (const routed of attempts) {
		try {
			const submitted = await routed.protocol.submit({
				model: routed.upstreamModel,
				family,
				apiKey: routed.apiKey,
				baseUrl: routed.baseUrl,
				prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
				duration,
				resolution: parseResolution(raw.resolution),
				aspectRatio:
					typeof raw.aspectRatio === "string" ? raw.aspectRatio : undefined,
				generateAudio: raw.generateAudio === true,
				imageUrl,
				body: passthrough,
			});
			return NextResponse.json({
				channelId: routed.channel.id,
				protocol: routed.protocol.id,
				jobId: submitted.jobId,
			});
		} catch (error) {
			failures.push(
				`${routed.channel.name}: ${error instanceof Error ? error.message : "未知错误"}`,
			);
		}
	}

	// Nothing was submitted, so nothing should have been charged.
	if (cost > 0) {
		await refundTask({
			userId: user.id,
			refId,
			note: "all channels failed",
			modelId: model.id,
		});
	}

	return NextResponse.json(
		{ error: "all_channels_failed", details: failures },
		{ status: 502 },
	);
}
