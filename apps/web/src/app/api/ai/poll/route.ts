import { type NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/auth/guard";
import {
	familyForKind,
	getChannel,
	getChannelCredential,
} from "@/services/admin/channels";
import { getModel } from "@/services/admin/models";
import { getProtocol } from "@/services/ai/protocols";
import { refundTask } from "@/services/billing/ledger";

/**
 * Poll one submitted job.
 *
 * Requires the same session that submitted it, so a job's credits, its channel
 * and its caller stay one account. A job that ends up failed is refunded here —
 * the amount comes from the frozen row, never from the request.
 *
 * The caller sends back only what it was given — a channel id and a job id.
 * Everything else (protocol, upstream model name, endpoint, key) is
 * re-resolved here, and the channel is checked to actually serve this model, so
 * no caller-supplied URL is ever fetched.
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
	const channelId = typeof raw.channelId === "string" ? raw.channelId : "";
	const jobId = typeof raw.jobId === "string" ? raw.jobId : "";
	const refId = typeof raw.refId === "string" ? raw.refId : "";
	if (!modelId || !channelId || !jobId) {
		return NextResponse.json({ error: "invalid_handle" }, { status: 400 });
	}

	const [model, channel] = await Promise.all([
		getModel({ id: modelId }),
		getChannel(channelId),
	]);
	if (!model || !model.enabled || !channel) {
		return NextResponse.json({ error: "model_unavailable" }, { status: 404 });
	}

	// The channel must actually serve this model, and still be enabled.
	const upstreamModel = channel.models[modelId];
	if (!upstreamModel || !channel.enabled) {
		return NextResponse.json({ error: "model_unavailable" }, { status: 404 });
	}

	const protocol = getProtocol(channel.protocol);
	const family = familyForKind(model.kind);
	const apiKey = await getChannelCredential(channel.id);
	if (!protocol || !family || !apiKey) {
		return NextResponse.json({ error: "channel_unavailable" }, { status: 404 });
	}

	try {
		const state = await protocol.poll(
			{
				protocol: protocol.id,
				channelId: channel.id,
				modelId,
				jobId,
				model: upstreamModel,
				baseUrl: channel.baseUrl,
				family,
			},
			{ apiKey },
		);

		// A job that failed costs nothing; the caller retries on another channel
		// with a fresh ref, so the freeze booked for this attempt goes back.
		if (state.state === "failed" && refId) {
			try {
				await refundTask({
					userId: user.id,
					refId,
					note: state.error,
					modelId,
				});
			} catch (error) {
				// Never break the poll answer over a refund: the client's next move
				// (retry, or report the failure) does not depend on it.
				console.error("refund failed:", error);
			}
		}

		return NextResponse.json(state);
	} catch (error) {
		return NextResponse.json(
			{
				error: "poll_failed",
				details: error instanceof Error ? error.message : "未知错误",
			},
			{ status: 502 },
		);
	}
}
