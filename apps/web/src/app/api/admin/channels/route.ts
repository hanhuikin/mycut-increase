import { type NextRequest, NextResponse } from "next/server";
import { requireElevatedAdmin } from "@/auth/guard";
import { clientIp } from "@/auth/request-ip";
import { parseChannelInput } from "@/services/admin/channel-input";
import { createChannel, listChannels } from "@/services/admin/channels";
import { protocolOptions } from "@/services/ai/protocols";
import { writeAudit } from "@/services/audit";

/** Channels plus the protocol list the editor's type picker needs. */
export async function GET() {
	const gate = await requireElevatedAdmin();
	if (!gate.ok) {
		return NextResponse.json({ error: gate.status }, { status: gate.status });
	}
	return NextResponse.json({
		channels: await listChannels(),
		protocols: protocolOptions(),
	});
}

/** Create a channel. It may start without a key — such a channel is skipped. */
export async function POST(request: NextRequest) {
	const gate = await requireElevatedAdmin();
	if (!gate.ok) {
		return NextResponse.json({ error: gate.status }, { status: gate.status });
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "invalid_json" }, { status: 400 });
	}

	const parsed = await parseChannelInput(body);
	if (!parsed.ok) {
		return NextResponse.json({ error: parsed.error }, { status: 400 });
	}

	const created = await createChannel({
		input: parsed.input,
		actor: gate.user.email,
	});

	await writeAudit({
		actorId: gate.user.id,
		actorEmail: gate.user.email,
		action: "channel_create",
		target: parsed.input.name,
		detail: JSON.stringify({
			protocol: parsed.input.protocol,
			models: Object.keys(parsed.input.models),
		}),
		ip: clientIp({ request }),
	});

	return NextResponse.json({ channel: created }, { status: 201 });
}
