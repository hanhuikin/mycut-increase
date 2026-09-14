import { type NextRequest, NextResponse } from "next/server";
import { webEnv } from "@/env/web";

const ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3";

/**
 * 火山方舟 Seedance 2.0 创建视频生成任务
 *
 * 关键: ark API key 只在服务端使用（webEnv.ARK_API_KEY），不暴露给浏览器。
 * 浏览器通过 POST /api/ai-video/generate 提交，拿到 taskId 后再轮询 /api/ai-video/status。
 */
export async function POST(request: NextRequest) {
	const apiKey = webEnv.ARK_API_KEY;
	if (!apiKey) {
		return NextResponse.json(
			{ error: "未配置 ARK_API_KEY" },
			{ status: 500 },
		);
	}

	try {
		const body = await request.json();
		const { prompt, ratio, duration, resolution, generate_audio } = body;

		if (!prompt || typeof prompt !== "string") {
			return NextResponse.json(
				{ error: "Missing prompt" },
				{ status: 400 },
			);
		}

		const res = await fetch(`${ARK_BASE}/contents/generations/tasks`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model: "doubao-seedance-2-0-260128",
				content: [{ type: "text", text: prompt }],
				ratio: ratio || "16:9",
				...(duration !== undefined && duration !== "auto"
					? { duration: Number(duration) }
					: {}),
				resolution: resolution || "720p",
				generate_audio: generate_audio ?? false,
			}),
		});

		if (!res.ok) {
			const errText = await res.text();
			console.error("Ark generate error:", res.status, errText);
			return NextResponse.json(
				{ error: "Ark generate failed", details: errText },
				{ status: 502 },
			);
		}

		const json = await res.json();
		if (!json.id) {
			return NextResponse.json(
				{ error: "Ark returned no task id", details: JSON.stringify(json) },
				{ status: 502 },
			);
		}

		return NextResponse.json({ taskId: json.id }, { status: 200 });
	} catch (error) {
		console.error("Ark generate error:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}
