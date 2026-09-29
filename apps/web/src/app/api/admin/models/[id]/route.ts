import { type NextRequest, NextResponse } from "next/server";
import { requireElevatedAdmin } from "@/auth/guard";
import { clientIp } from "@/auth/request-ip";
import {
	type EditableModelFields,
	getModelDetail,
	updateModel,
} from "@/services/admin/models";
import { writeAudit } from "@/services/audit";

const VIDEO_MODES = ["text-to-video", "image-to-video"] as const;

type Sanitized =
	| { ok: true; patch: EditableModelFields }
	| { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Integer-or-null, where null clears the price. */
function intOrNull(value: unknown): number | null | undefined {
	if (value === null) return null;
	return typeof value === "number" && Number.isFinite(value)
		? Math.round(value)
		: undefined;
}

/**
 * Everything the panel may change, validated field by field. `id` and `kind`
 * are deliberately absent: the model set is fixed and has no create flow.
 */
function sanitize(body: Record<string, unknown>): Sanitized {
	const patch: EditableModelFields = {};

	for (const field of ["label"] as const) {
		if (field in body) {
			const value = body[field];
			if (typeof value !== "string" || !value.trim()) {
				return { ok: false, error: `${field} must be a non-empty string` };
			}
			patch.label = value.trim().slice(0, 120);
		}
	}

	for (const field of ["labelKey", "descriptionKey"] as const) {
		if (field in body) {
			const value = body[field];
			if (value !== null && typeof value !== "string") {
				return { ok: false, error: `${field} must be a string or null` };
			}
			patch[field] = value === null ? null : value.trim() || null;
		}
	}

	for (const field of ["enabled", "requiresPro", "supportsAudio"] as const) {
		if (field in body) {
			const value = body[field];
			if (typeof value !== "boolean") {
				return { ok: false, error: `${field} must be a boolean` };
			}
			patch[field] = value;
		}
	}

	// These two are required numbers; dailyLimit alone may be cleared.
	for (const field of ["maxDuration", "sortOrder"] as const) {
		if (field in body) {
			const value = intOrNull(body[field]);
			if (value === undefined || value === null) {
				return { ok: false, error: `${field} must be a number` };
			}
			patch[field] = value;
		}
	}

	if ("dailyLimit" in body) {
		const value = intOrNull(body.dailyLimit);
		if (value === undefined) {
			return { ok: false, error: "dailyLimit must be a number or null" };
		}
		patch.dailyLimit = value;
	}

	for (const field of [
		"pricePerSecond720",
		"pricePerSecond1080",
		"pricePerCall",
	] as const) {
		if (field in body) {
			const value = intOrNull(body[field]);
			if (value === undefined || (value !== null && value < 0)) {
				return {
					ok: false,
					error: `${field} must be a non-negative number or null`,
				};
			}
			patch[field] = value;
		}
	}

	if ("modes" in body) {
		const value = body.modes;
		if (
			!Array.isArray(value) ||
			!value.every((mode) =>
				(VIDEO_MODES as readonly string[]).includes(mode as string),
			)
		) {
			return {
				ok: false,
				error: `modes must be an array of ${VIDEO_MODES.join(" | ")}`,
			};
		}
		// De-duplicate while preserving the canonical order.
		patch.modes = VIDEO_MODES.filter((mode) =>
			(value as string[]).includes(mode),
		);
	}

	if (Object.keys(patch).length === 0) {
		return { ok: false, error: "no editable fields supplied" };
	}
	return { ok: true, patch };
}

export async function GET(
	_request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const gate = await requireElevatedAdmin();
	if (!gate.ok) {
		return NextResponse.json({ error: gate.status }, { status: gate.status });
	}

	const { id } = await params;
	const model = await getModelDetail({ id });
	if (!model) {
		return NextResponse.json({ error: "not_found" }, { status: 404 });
	}
	return NextResponse.json({ model });
}

export async function PATCH(
	request: NextRequest,
	{ params }: { params: Promise<{ id: string }> },
) {
	const gate = await requireElevatedAdmin();
	if (!gate.ok) {
		return NextResponse.json({ error: gate.status }, { status: gate.status });
	}

	const { id } = await params;

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return NextResponse.json({ error: "invalid_json" }, { status: 400 });
	}
	if (!isPlainObject(body)) {
		return NextResponse.json({ error: "invalid_body" }, { status: 400 });
	}

	const sanitized = sanitize(body);
	if (!sanitized.ok) {
		return NextResponse.json({ error: sanitized.error }, { status: 400 });
	}

	const updated = await updateModel({ id, patch: sanitized.patch });
	if (!updated) {
		return NextResponse.json({ error: "not_found" }, { status: 404 });
	}

	await writeAudit({
		actorId: gate.user.id,
		actorEmail: gate.user.email,
		action: "model_update",
		target: id,
		detail: JSON.stringify(sanitized.patch),
		ip: clientIp({ request }),
	});

	// Return the detail shape so the drawer picks up fresh route status too.
	return NextResponse.json({ model: await getModelDetail({ id }) });
}
