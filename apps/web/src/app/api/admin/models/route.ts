import { type NextRequest, NextResponse } from "next/server";
import { requireElevatedAdmin } from "@/auth/guard";
import {
	createModel,
	getModelDetail,
	isValidModelId,
	listModels,
} from "@/services/admin/models";
import { writeAudit } from "@/services/audit";

const KINDS = ["video", "tool", "audio", "local"] as const;
type Kind = (typeof KINDS)[number];

function parseKind(value: unknown): Kind | null {
	return typeof value === "string" && (KINDS as readonly string[]).includes(value)
		? (value as Kind)
		: null;
}

/** The model list. Edits go to `/api/admin/models/[id]`. */
export async function GET() {
	const gate = await requireElevatedAdmin();
	if (!gate.ok) {
		return NextResponse.json({ error: gate.status }, { status: gate.status });
	}
	const models = await listModels({ enabledOnly: false });
	return NextResponse.json({ models });
}

/**
 * Create a model. Only the identity is taken here — routes, keys, pricing and
 * capabilities are configured in the drawer, and the new model starts disabled
 * so it cannot be used before it is wired up.
 *
 * `id` is the primary key and is referenced by the ledger and by per-user
 * grants, so it is fixed the moment it is created.
 */
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

	const source = body as { id?: unknown; label?: unknown; kind?: unknown };
	const id = typeof source.id === "string" ? source.id.trim().toLowerCase() : "";
	const label = typeof source.label === "string" ? source.label.trim() : "";
	const kind = parseKind(source.kind);

	if (!isValidModelId(id)) {
		return NextResponse.json({ error: "invalid_id" }, { status: 400 });
	}
	if (!label) {
		return NextResponse.json({ error: "label_required" }, { status: 400 });
	}
	if (!kind) {
		return NextResponse.json({ error: "invalid_kind" }, { status: 400 });
	}

	const created = await createModel({ id, label, kind });
	if (!created) {
		return NextResponse.json({ error: "id_taken" }, { status: 409 });
	}

	await writeAudit({
		actorId: gate.user.id,
		actorEmail: gate.user.email,
		action: "model_create",
		target: id,
		detail: JSON.stringify({ label, kind }),
		ip: request.headers.get("x-forwarded-for") ?? "",
	});

	return NextResponse.json(
		{ model: await getModelDetail({ id }) },
		{ status: 201 },
	);
}
