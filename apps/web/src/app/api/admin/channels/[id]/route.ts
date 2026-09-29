import { type NextRequest, NextResponse } from "next/server";
import { requireElevatedAdmin } from "@/auth/guard";
import { parseChannelInput } from "@/services/admin/channel-input";
import {
	deleteChannel,
	getChannel,
	updateChannel,
} from "@/services/admin/channels";
import { writeAudit } from "@/services/audit";

/** Update a channel. An omitted or empty `apiKey` leaves the stored key alone. */
export async function PATCH(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const gate = await requireElevatedAdmin();
	if (!gate.ok) {
		return NextResponse.json({ error: gate.status }, { status: gate.status });
	}

	const { id } = await params;
	if (!(await getChannel(id))) {
		return NextResponse.json({ error: "not_found" }, { status: 404 });
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

	const updated = await updateChannel({
		id,
		input: parsed.input,
		actor: gate.user.email,
	});

	await writeAudit({
		actorId: gate.user.id,
		actorEmail: gate.user.email,
		action: "channel_update",
		target: parsed.input.name,
		detail: JSON.stringify({
			protocol: parsed.input.protocol,
			models: Object.keys(parsed.input.models),
			// Never the key itself — only whether one was supplied.
			keyReplaced: Boolean(parsed.input.apiKey.trim()),
		}),
		ip: request.headers.get("x-forwarded-for") ?? "",
	});

	return NextResponse.json({ channel: updated });
}

/** Delete a channel. Models it was the only server for become unroutable. */
export async function DELETE(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const gate = await requireElevatedAdmin();
	if (!gate.ok) {
		return NextResponse.json({ error: gate.status }, { status: gate.status });
	}

	const { id } = await params;
	const existing = await getChannel(id);
	if (!existing) {
		return NextResponse.json({ error: "not_found" }, { status: 404 });
	}

	const deleted = await deleteChannel(id);
	if (!deleted) {
		return NextResponse.json({ error: "not_found" }, { status: 404 });
	}

	await writeAudit({
		actorId: gate.user.id,
		actorEmail: gate.user.email,
		action: "channel_delete",
		target: existing.name,
		detail: JSON.stringify({
			protocol: existing.protocol,
			models: Object.keys(existing.models),
		}),
		ip: request.headers.get("x-forwarded-for") ?? "",
	});

	return NextResponse.json({ ok: true });
}
