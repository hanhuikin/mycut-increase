"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useLocale } from "@/locale/locale-context";
import { GateErrorView, type GateStatus } from "../gate-error-view";

/** Manual credit adjustments + redeem-code generation (v1 top-up channel). */
export default function AdminBillingPage() {
	const [gateError, setGateError] = useState<GateStatus | null>(null);

	if (gateError) {
		return <GateErrorView status={gateError} />;
	}

	return (
		<div className="grid gap-4 lg:grid-cols-2">
			<AdjustForm onError={setGateError} />
			<CodesGenerator onError={setGateError} />
		</div>
	);
}

function FormCard({
	title,
	children,
}: {
	title: string;
	children: React.ReactNode;
}) {
	return (
		<Card className="gap-3">
			<CardHeader>
				<CardTitle className="text-[11.5px] font-semibold tracking-[0.16em] text-muted-foreground uppercase">
					{title}
				</CardTitle>
			</CardHeader>
			<CardContent>{children}</CardContent>
		</Card>
	);
}

function AdjustForm({ onError }: { onError: (status: GateStatus) => void }) {
	const { t } = useLocale();
	const [email, setEmail] = useState("");
	const [delta, setDelta] = useState("");
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);

	const resolveUser = async (): Promise<string | null> => {
		const res = await fetch(
			`/api/admin/users?q=${encodeURIComponent(email.trim())}`,
		);
		if (!res.ok) {
			onError(String(res.status) as GateStatus);
			return null;
		}
		const body = (await res.json()) as {
			users: Array<{ id: string; email: string }>;
		};
		const match = body.users.find(
			(user) => user.email.toLowerCase() === email.trim().toLowerCase(),
		);
		return match?.id ?? null;
	};

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		const parsed = Number(delta);
		if (!email || !Number.isFinite(parsed) || parsed === 0 || !reason.trim()) {
			toast.error(t["auth.error.generic"]);
			return;
		}
		setBusy(true);
		try {
			const userId = await resolveUser();
			if (!userId) {
				toast.error(t["admin.users.empty"]);
				return;
			}
			const res = await fetch("/api/admin/credits", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ userId, delta: parsed, reason: reason.trim() }),
			});
			if (!res.ok) {
				onError(String(res.status) as GateStatus);
				return;
			}
			const body = (await res.json()) as { balance: number };
			toast.success(
				t["admin.billing.adjust_done"].replace("{count}", String(body.balance)),
			);
			setDelta("");
			setReason("");
		} finally {
			setBusy(false);
		}
	};

	return (
		<FormCard title={t["admin.billing.adjust_title"]}>
			<form onSubmit={submit} className="flex flex-col gap-2.5">
				<Input
					type="email"
					value={email}
					onChange={(event) => setEmail(event.target.value)}
					placeholder={t["admin.billing.adjust_user"]}
					size="sm"
				/>
				<Input
					type="number"
					value={delta}
					onChange={(event) => setDelta(event.target.value)}
					placeholder={t["admin.billing.adjust_delta"]}
					size="sm"
					className="font-mono"
				/>
				<Input
					value={reason}
					onChange={(event) => setReason(event.target.value)}
					placeholder={t["admin.billing.adjust_reason"]}
					size="sm"
				/>
				<Button type="submit" disabled={busy} className="w-full">
					{t["admin.billing.adjust_submit"]}
				</Button>
			</form>
		</FormCard>
	);
}

function CodesGenerator({ onError }: { onError: (status: GateStatus) => void }) {
	const { t } = useLocale();
	const [count, setCount] = useState("10");
	const [credits, setCredits] = useState("500");
	const [codes, setCodes] = useState<string[] | null>(null);
	const [busy, setBusy] = useState(false);

	const submit = async (event: React.FormEvent) => {
		event.preventDefault();
		setBusy(true);
		try {
			const res = await fetch("/api/admin/codes", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					count: Number(count),
					credits: Number(credits),
				}),
			});
			if (!res.ok) {
				onError(String(res.status) as GateStatus);
				return;
			}
			const body = (await res.json()) as { codes: string[] };
			setCodes(body.codes);
		} finally {
			setBusy(false);
		}
	};

	return (
		<FormCard title={t["admin.billing.codes_title"]}>
			<form onSubmit={submit} className="flex flex-col gap-2.5">
				<div className="flex gap-2.5">
					<Input
						type="number"
						min={1}
						max={100}
						value={count}
						onChange={(event) => setCount(event.target.value)}
						placeholder={t["admin.billing.codes_count"]}
						size="sm"
						className="font-mono"
					/>
					<Input
						type="number"
						min={1}
						value={credits}
						onChange={(event) => setCredits(event.target.value)}
						placeholder={t["admin.billing.codes_credits"]}
						size="sm"
						className="font-mono"
					/>
				</div>
				<Button type="submit" disabled={busy} className="w-full">
					{t["admin.billing.codes_generate"]}
				</Button>

				{codes && (
					<div>
						<div className="mb-1.5 flex items-center justify-between">
							<span className="text-muted-foreground text-[12.5px]">
								{t["admin.billing.codes_result"]}
							</span>
							<Button
								type="button"
								variant="link"
								className="h-auto p-0 text-[12.5px]"
								onClick={() => {
									navigator.clipboard.writeText(codes.join("\n"));
									toast.success(t["admin.billing.copied"]);
								}}
							>
								{t["admin.billing.codes_copy"]}
							</Button>
						</div>
						<pre className="bg-muted max-h-48 overflow-auto rounded-md p-2.5 font-mono text-[12.5px] leading-relaxed">
							{codes.join("\n")}
						</pre>
					</div>
				)}
			</form>
		</FormCard>
	);
}
