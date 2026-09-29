"use client";

import { useState } from "react";
import { useLocale } from "@/locale/locale-context";
import { toast } from "sonner";
import { redeemCredits } from "@/services/billing/client";

/** Shared redeem-code form: used by the balance chip and the insufficient dialog. */
export function RedeemForm({ onDone }: { onDone: () => void }) {
	const { t } = useLocale();
	const [code, setCode] = useState("");
	const [busy, setBusy] = useState(false);

	return (
		<form
			onSubmit={async (event) => {
				event.preventDefault();
				if (!code.trim()) return;
				setBusy(true);
				try {
					const result = await redeemCredits({ code: code.trim() });
					if (result.ok && result.credits != null) {
						toast.success(
							t["billing.redeem_success"]
								.replace("{count}", String(result.credits))
								.replace("{balance}", String(result.balance ?? "")),
						);
						setCode("");
						onDone();
					} else {
						toast.error(t["billing.redeem_invalid"]);
					}
				} finally {
					setBusy(false);
				}
			}}
		>
			<input
				autoFocus
				value={code}
				onChange={(event) => setCode(event.target.value)}
				placeholder={t["billing.redeem_placeholder"]}
				className="border-border bg-background focus:border-primary mb-3 h-9 w-full rounded-lg border px-3 font-mono text-xs uppercase outline-none"
			/>
			<div className="flex gap-2">
				<button
					type="submit"
					disabled={busy || !code.trim()}
					className="bg-primary text-primary-foreground h-9 flex-1 rounded-lg text-xs font-semibold disabled:opacity-50"
				>
					{t["billing.redeem_submit"]}
				</button>
			</div>
		</form>
	);
}

/** Balance pill shown in the AI panel header; 充值 opens the redeem dialog (v1). */
export function BalanceChip({
	balance,
	onRedeemed,
}: {
	balance: number | null;
	onRedeemed: () => void;
}) {
	const { t } = useLocale();
	const [open, setOpen] = useState(false);

	return (
		<span className="border-primary/40 text-muted-foreground relative inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11.5px]">
			{t["billing.balance"].replace("{count}", String(balance ?? "—"))}
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="text-primary hover:underline"
			>
				· {t["billing.top_up"]}
			</button>

			{open && (
				<span
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
					onClick={() => setOpen(false)}
				>
					<span
						className="bg-card border-border mx-4 block w-full max-w-xs rounded-xl border p-4"
						onClick={(event) => event.stopPropagation()}
					>
						<h3 className="mb-2 text-sm font-semibold">
							{t["billing.redeem_title"]}
						</h3>
						<RedeemForm
							onDone={() => {
								setOpen(false);
								onRedeemed();
							}}
						/>
					</span>
				</span>
			)}
		</span>
	);
}
