import { withRoute } from "@/services/logging/with-route";
import { type NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/auth/guard";
import {
	estimateModelCost,
	getModel,
	hasModelGrant,
} from "@/services/admin/models";
import { familyForKind, resolveChannelChain } from "@/services/admin/channels";
import {
	countFreezesToday,
	freezeForTask,
	getBalance,
	hasFrozenRef,
	LedgerError,
	refundTask,
	settleTask,
} from "@/services/billing/ledger";

/** 历史固定档；之外的 "宽x高" 走下方动态校验（与生图对话框能力上限一致）。 */
const IMAGE_SIZES: readonly string[] = [
	"1024x1024",
	"1536x1024",
	"1024x1536",
	"256x256",
];
const MAX_IMAGES = 4;

const SIZE_PATTERN = /^(\d{3,4})x(\d{3,4})$/;

function parseSize(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	if (IMAGE_SIZES.includes(value)) return value;
	const match = SIZE_PATTERN.exec(value);
	if (!match) return undefined;
	const width = Number(match[1]);
	const height = Number(match[2]);
	// 每边 256–1536：与 img2img-store 的 IMG2IMG_SIZE_CAPS 保持一致
	if (width < 256 || height < 256 || width > 1536 || height > 1536) {
		return undefined;
	}
	return value;
}

/**
 * Synchronous image generation. Unlike the async submit/poll flow, the
 * vendor returns finished pictures in one call, so the whole lifecycle —
 * freeze → generate → settle (or refund) — happens inside this request.
 *
 * The billing model is per-call (`pricePerCall`); a single call may ask
 * for up to MAX_IMAGES pictures and is charged once.
 */
async function postHandler(request: NextRequest) {
	const user = await getSessionUser();
	if (!user) {
		return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
	}

	let raw: Record<string, unknown>;
	try {
		raw = await request.json();
	} catch {
		return NextResponse.json({ error: "invalid_json" }, { status: 400 });
	}
	const modelId = typeof raw.modelId === "string" ? raw.modelId : "";
	const model = modelId ? await getModel({ id: modelId }) : null;
	if (!model || !model.enabled) {
		return NextResponse.json({ error: "model_unavailable" }, { status: 404 });
	}

	const refId = typeof raw.refId === "string" ? raw.refId : "";
	if (!refId) {
		return NextResponse.json({ error: "refId_required" }, { status: 400 });
	}
	if (await hasFrozenRef({ refId })) {
		return NextResponse.json({ error: "refId_reused" }, { status: 409 });
	}

	if (
		model.requiresPro &&
		user.plan !== "pro" &&
		!(await hasModelGrant({ userId: user.id, modelId: model.id }))
	) {
		return NextResponse.json({ error: "pro_required" }, { status: 403 });
	}

	const family = familyForKind(model.kind);
	if (family !== "image") {
		return NextResponse.json({ error: "model_not_image" }, { status: 400 });
	}

	const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
	if (!prompt) {
		return NextResponse.json({ error: "prompt_required" }, { status: 400 });
	}
	const size = parseSize(raw.size) ?? "1024x1024";
	const count = Math.min(
		Math.max(typeof raw.count === "number" ? Math.round(raw.count) : 1, 1),
		MAX_IMAGES,
	);
	// 参考图（图生图/多图融合）：data: 或 https 链接，最多 MAX_IMAGES 张
	const images = Array.isArray(raw.images)
		? raw.images
				.filter(
					(url): url is string =>
						typeof url === "string" &&
						(url.startsWith("data:image/") || url.startsWith("https://")),
				)
				.slice(0, MAX_IMAGES)
		: [];

	// 一次调用可要 n 张：按 张数 × 单价 计费（与前端「单价 × 数量」展示一致）
	const cost =
		estimateModelCost({ model, resolution: "720p", seconds: 0 }) * count;
	if (model.dailyLimit != null) {
		const usedToday = await countFreezesToday({
			userId: user.id,
			modelId: model.id,
		});
		if (usedToday >= model.dailyLimit) {
			return NextResponse.json({ error: "daily_limit" }, { status: 429 });
		}
	}

	const chain = await resolveChannelChain({
		modelId: model.id,
		kind: model.kind,
	});
	const attempts = chain.filter((routed) => routed.protocol.generateImage);
	if (attempts.length === 0) {
		return NextResponse.json(
			{ error: "no_channel_available" },
			{ status: 503 },
		);
	}

	if (cost > 0) {
		try {
			await freezeForTask({
				userId: user.id,
				refId,
				amount: cost,
				note: `${model.label} ${size} x${count}`,
				modelId: model.id,
			});
		} catch (error) {
			if (error instanceof LedgerError && error.code === "insufficient") {
				return NextResponse.json(
					{
						error: "insufficient",
						cost,
						balance: await getBalance({ userId: user.id }),
					},
					{ status: 402 },
				);
			}
			throw error;
		}
	}

	const failures: string[] = [];
	for (const routed of attempts) {
		try {
		const generated = await routed.protocol.generateImage?.({
			model: routed.upstreamModel,
			apiKey: routed.apiKey,
			baseUrl: routed.baseUrl,
			prompt,
			size,
			count,
			...(images.length > 0 ? { images } : {}),
		});
			if (!generated || generated.dataUrls.length === 0) {
				throw new Error("供应商返回了空结果");
			}
			if (cost > 0) {
				await settleTask({
					userId: user.id,
					refId,
					actual: cost,
					modelId: model.id,
				});
			}
			return NextResponse.json({
				dataUrls: generated.dataUrls,
				channelId: routed.channel.id,
			});
		} catch (error) {
			failures.push(
				`${routed.channel.name}: ${error instanceof Error ? error.message : "未知错误"}`,
			);
		}
	}

	if (cost > 0) {
		await refundTask({
			userId: user.id,
			refId,
			note: "all channels failed",
			modelId: model.id,
		});
	}

	return NextResponse.json(
		{ error: "all_channels_failed", details: failures },
		{ status: 502 },
	);
}

export const POST = withRoute(postHandler);
