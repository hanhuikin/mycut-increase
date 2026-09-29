"use client";

import { useCallback, useEffect, useState } from "react";
import { authClient } from "@/auth/client";

export interface BillingModel {
	id: string;
	label: string;
	kind: string;
	/** Generation modes (video models); empty for tools and audio. */
	modes: string[];
	supportsAudio: boolean;
	maxDuration: number;
	labelKey: string | null;
	descriptionKey: string | null;
	pricePerSecond720: number | null;
	pricePerSecond1080: number | null;
	pricePerCall: number | null;
	enabled: boolean;
	requiresPro: boolean;
}

export interface BillingState {
	models: Map<string, BillingModel>;
	balance: number | null;
	plan: "free" | "pro" | null;
	granted: string[];
	signedIn: boolean;
	loading: boolean;
	refreshBalance: () => Promise<void>;
}

/** Client-side view of the admin-configured models + the user's credits. */
export function useBilling(): BillingState {
	const [models, setModels] = useState<Map<string, BillingModel>>(new Map());
	const [balance, setBalance] = useState<number | null>(null);
	const [plan, setPlan] = useState<"free" | "pro" | null>(null);
	const [granted, setGranted] = useState<string[]>([]);
	const [signedIn, setSignedIn] = useState(false);
	const [loading, setLoading] = useState(true);
	const { data: session, isPending } = authClient.useSession();

	const refreshBalance = useCallback(async () => {
		if (!session?.user) return;
		const res = await fetch("/api/billing/me");
		if (!res.ok) return;
		const body = (await res.json()) as { balance: number; plan: string };
		setBalance(body.balance);
		setPlan(body.plan === "pro" ? "pro" : "free");
	}, [session?.user]);

	useEffect(() => {
		if (isPending) return;
		(async () => {
			setLoading(true);
			try {
				const res = await fetch("/api/billing/models");
				if (res.ok) {
					const body = (await res.json()) as {
						models: BillingModel[];
						plan: string | null;
						granted: string[];
					};
					setModels(new Map(body.models.map((model) => [model.id, model])));
					setPlan(
						body.plan === "pro" ? "pro" : body.plan === "free" ? "free" : null,
					);
					setGranted(body.granted ?? []);
				}
				setSignedIn(Boolean(session?.user));
				if (session?.user) {
					await refreshBalance();
				}
			} finally {
				setLoading(false);
			}
		})();
	}, [isPending, session?.user, refreshBalance]);

	return {
		models,
		balance,
		plan,
		granted,
		signedIn,
		loading,
		refreshBalance,
	};
}

export function estimateCost({
	model,
	resolution,
	seconds,
}: {
	model: BillingModel;
	resolution: "480p" | "720p" | "1080p";
	seconds: number;
}): number {
	if (model.kind === "local") return 0;
	if (model.pricePerCall != null) return model.pricePerCall;
	const perSecond =
		resolution === "1080p" && model.pricePerSecond1080 != null
			? model.pricePerSecond1080
			: (model.pricePerSecond720 ?? 0);
	return perSecond * seconds;
}

/** Freeze → returns null when blocked (insufficient / unavailable). */
export async function freezeCredits({
	refId,
	modelId,
	resolution,
	seconds,
}: {
	refId: string;
	modelId: string;
	resolution: "480p" | "720p" | "1080p";
	seconds: number;
}): Promise<
	| { frozen: number }
	| { blocked: "insufficient"; cost: number; balance: number }
	| null
> {
	const res = await fetch("/api/billing/freeze", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ refId, modelId, resolution, seconds }),
	});
	if (res.status === 402) {
		const body = (await res.json()) as { cost: number; balance: number };
		return { blocked: "insufficient", cost: body.cost, balance: body.balance };
	}
	if (!res.ok) return null;
	const body = (await res.json()) as { frozen: number };
	return { frozen: body.frozen };
}

export async function settleCredits({
	refId,
	modelId,
	resolution,
	actualSeconds,
	failed = false,
}: {
	refId: string;
	modelId: string;
	resolution: "480p" | "720p" | "1080p";
	actualSeconds?: number;
	failed?: boolean;
}): Promise<void> {
	await fetch("/api/billing/settle", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ refId, modelId, resolution, actualSeconds, failed }),
	});
}

export async function redeemCredits({
	code,
}: {
	code: string;
}): Promise<{ ok: boolean; credits?: number; balance?: number }> {
	const res = await fetch("/api/billing/redeem", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ code }),
	});
	if (!res.ok) return { ok: false };
	const body = (await res.json()) as { credits: number; balance: number };
	return { ok: true, credits: body.credits, balance: body.balance };
}
