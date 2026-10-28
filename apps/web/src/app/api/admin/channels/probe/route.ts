import { type NextRequest, NextResponse } from "next/server";
import { requireElevatedAdmin } from "@/auth/guard";
import { checkRateLimit } from "@/auth/rate-limit";
import { clientIp } from "@/auth/request-ip";
import { getChannelCredential, isValidBaseUrl } from "@/services/admin/channels";
import { getProtocol } from "@/services/ai/protocols";
import { writeAudit } from "@/services/audit";

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Connectivity probe for a channel being created or edited. One call covers
 * both admin actions: a successful model-list fetch proves the endpoint +
 * key work, and the returned names feed the multi-select.
 *
 * The API key never reaches the client's storage here — a draft passes its
 * typed key transiently (new channel), or passes only the channel id so the
 * stored key is used server-side (edit, key left blank).
 */
export async function POST(request: NextRequest) {
	const gate = await requireElevatedAdmin();
	if (!gate.ok) {
		return NextResponse.json({ error: gate.status }, { status: gate.status });
	}

	const { limited } = await checkRateLimit({
		request,
		keySuffix: "probe",
	});
	if (limited) {
		return NextResponse.json(
			{ error: "too_many_requests" },
			{ status: 429 },
		);
	}

	let body: { protocol?: unknown; baseUrl?: unknown; apiKey?: unknown; channelId?: unknown };
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "invalid_json" }, { status: 400 });
	}

	const protocolId = typeof body.protocol === "string" ? body.protocol : "";
	const protocol = getProtocol(protocolId);
	if (!protocol) {
		return NextResponse.json({ error: "protocol_not_found" }, { status: 400 });
	}
	if (!protocol.listModels) {
		return NextResponse.json({ error: "list_unsupported" }, { status: 409 });
	}

	const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl : "";
	if (!baseUrl || !isValidBaseUrl(baseUrl)) {
		return NextResponse.json({ error: "invalid_base_url" }, { status: 400 });
	}

	// Resolve the key: a transient one typed into the dialog wins; otherwise
	// a channel id reuses the stored key (decrypted only server-side).
	const typedKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
	const channelId = typeof body.channelId === "string" ? body.channelId : "";
	let apiKey = typedKey;
	if (!apiKey && channelId) {
		apiKey = (await getChannelCredential(channelId)) ?? "";
	}
	if (!apiKey) {
		return NextResponse.json({ error: "key_required" }, { status: 400 });
	}

	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
		let models: string[];
		try {
			models = await protocol.listModels({ apiKey, baseUrl });
		} finally {
			clearTimeout(timer);
		}

		await writeAudit({
			actorId: gate.user.id,
			actorEmail: gate.user.email,
			action: "channel_probe",
			target: channelId || `${protocol.label} ${baseUrl}`,
			detail: JSON.stringify({ protocol: protocolId, models: models.length }),
			ip: clientIp({ request }),
		});

		return NextResponse.json({ ok: true, models });
	} catch (error) {
		const message =
			error instanceof Error
				? error.name === "AbortError"
					? "probe_timeout"
					: error.message
				: "probe_failed";
		return NextResponse.json({ ok: false, error: message }, { status: 502 });
	}
}
