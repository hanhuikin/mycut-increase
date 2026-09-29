import { type NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth/server";
import { getSessionUser, issueAdminGate, ADMIN_GATE_TTL_MS } from "@/auth/guard";
import { clientIp } from "@/auth/request-ip";
import { writeAudit } from "@/services/audit";

/**
 * Step-up verification for the admin panel: re-enter the account password
 * (plus the TOTP code when 2FA is on). Issues the 30-minute gate cookie.
 */
export async function POST(request: NextRequest) {
	const user = await getSessionUser();
	if (!user) {
		return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
	}
	if (user.role !== "admin") {
		return NextResponse.json({ error: "forbidden" }, { status: 403 });
	}

	const body = (await request.json()) as {
		password?: string;
		totp?: string;
	};
	if (!body.password) {
		return NextResponse.json({ error: "password required" }, { status: 400 });
	}

	// Verify the password by attempting a scoped sign-in: on success better-auth
	// would set a *new* session cookie, but we never forward those headers, so
	// the caller's real session is untouched.
	let passwordOk = false;
	let twoFactorRequired = false;
	try {
		await auth.api.signInEmail({
			body: { email: user.email, password: body.password },
			headers: request.headers,
		});
		passwordOk = true;
	} catch (error) {
		const message = String((error as Error)?.message ?? "");
		const code = String((error as { code?: string })?.code ?? "");
		if (/two.?factor/i.test(message) || /two.?factor/i.test(code)) {
			// The password itself was accepted; only the second factor is missing.
			passwordOk = true;
			twoFactorRequired = true;
		}
	}

	if (!passwordOk) {
		return NextResponse.json(
			{ error: "bad_credentials" },
			{ status: 401 },
		);
	}

	if (user.twoFactorEnabled || twoFactorRequired) {
		const totp = body.totp?.trim() ?? "";
		if (!totp) {
			return NextResponse.json(
				{ error: "totp_required" },
				{ status: 401 },
			);
		}
		const verifyTotp = (
			auth.api as unknown as Record<
				string,
				| ((args: {
						body: { code: string };
						headers: Headers;
				  }) => Promise<unknown>)
				| undefined
			>
		)["verifyTOTP"];
		if (typeof verifyTotp !== "function") {
			return NextResponse.json(
				{ error: "totp_unavailable" },
				{ status: 503 },
			);
		}
		try {
			await verifyTotp.call(auth.api, {
				body: { code: totp },
				headers: request.headers,
			});
		} catch {
			return NextResponse.json({ error: "totp_invalid" }, { status: 401 });
		}
	}

	await issueAdminGate();
	const ip = clientIp({ request });
	await writeAudit({
		actorId: user.id,
		actorEmail: user.email,
		action: "elevate",
		detail: "entered admin panel",
		ip,
	});

	return NextResponse.json({
		ok: true,
		expiresInMinutes: ADMIN_GATE_TTL_MS / 60000,
	});
}
