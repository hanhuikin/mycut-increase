import { type NextRequest, NextResponse } from "next/server";
import { webEnv } from "@/env/web";

const ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3";

/**
 * 火山方舟 Seedance 2.0 查询视频生成任务状态
 *
 * 浏览器轮询此接口拿到任务状态和视频 URL。key 只在服务端。
 */
export async function GET(request: NextRequest) {
	const apiKey = webEnv.ARK_API_KEY;
	if (!apiKey) {
		return NextResponse.json(
			{ error: "未配置 ARK_API_KEY" },
			{ status: 500 },
		);
	}

	const { searchParams } = new URL(request.url);
	const taskId = searchParams.get("taskId");

	if (!taskId) {
		return NextResponse.json(
			{ error: "Missing taskId" },
			{ status: 400 },
		);
	}

	try {
		const res = await fetch(`${ARK_BASE}/contents/generations/tasks/${taskId}`, {
			headers: { Authorization: `Bearer ${apiKey}` },
		});

		if (!res.ok) {
			const errText = await res.text();
			console.error("Ark status error:", res.status, errText);
			return NextResponse.json(
				{ error: "Ark status failed", details: errText },
				{ status: 502 },
			);
		}

		const task = await res.json();
		return NextResponse.json(task, { status: 200 });
	} catch (error) {
		console.error("Ark status error:", error);
		return NextResponse.json(
			{ error: "Internal server error" },
			{ status: 500 },
		);
	}
}
