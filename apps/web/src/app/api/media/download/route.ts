import { withRoute } from "@/services/logging/with-route";
import { type NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/auth/guard";
import { userOwnsVideoUrl } from "@/services/ai/tasks";

/**
 * 视频下载代理
 *
 * 目的: 火山方舟返回的 TOS 视频地址不带 CORS 头，浏览器直接 fetch 会被拦截。
 * 这个路由在服务端拉取视频字节流并回传给浏览器，从而绕过 CORS。
 *
 * 用法: GET /api/media/download?url=<TOS视频地址>（需登录）
 *
 * 安全考虑:
 * - 必须携带有效会话，未登录直接 401
 * - url 必须出现在调用者自己的 generation_tasks.video_url 里（403），
 *   防止把服务器当作任意外部视频的开放代理
 * - url 必须是 https 绝对地址
 * - 只代理视频文件（mp4/webm/mov 等），防止被当作 SSRF 代理任意内网地址
 * - 通过 response 校验 content-type 限制只回传媒体类型
 * - 同源 fetch 不需要 CORS 头，因此不再回传 Access-Control-Allow-Origin: *
 */

const ALLOWED_PROTOCOLS = ["https:"];
const ALLOWED_CONTENT_TYPES = [
	"video/mp4",
	"video/webm",
	"video/quicktime",
	"video/x-m4v",
];

async function getHandler(request: NextRequest) {
	const user = await getSessionUser();
	if (!user) {
		return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
	}

	const { searchParams } = new URL(request.url);
	const targetUrl = searchParams.get("url");

	if (!targetUrl) {
		return NextResponse.json(
			{ error: "Missing url parameter" },
			{ status: 400 },
		);
	}

	// 校验 URL 格式，防止 SSRF
	let parsed: URL;
	try {
		parsed = new URL(targetUrl);
	} catch {
		return NextResponse.json(
			{ error: "Invalid url parameter" },
			{ status: 400 },
		);
	}

	if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
		return NextResponse.json(
			{ error: "Only https URLs are allowed" },
			{ status: 400 },
		);
	}

	// 归属校验：只代理调用者自己任务产出的视频地址
	if (!(await userOwnsVideoUrl({ userId: user.id, url: targetUrl }))) {
		return NextResponse.json({ error: "unknown_url" }, { status: 403 });
	}

	try {
		// 服务端拉取视频字节流
		const upstream = await fetch(targetUrl, {
			headers: {
				Accept: "video/*",
			},
		});

		if (!upstream.ok) {
			return NextResponse.json(
				{ error: `Upstream request failed (${upstream.status})` },
				{ status: 502 },
			);
		}

		const contentType = upstream.headers.get("content-type") || "";
		// 校验回传的是视频内容
		if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
			return NextResponse.json(
				{ error: `Unexpected content type: ${contentType}` },
				{ status: 502 },
			);
		}

		const contentLength = upstream.headers.get("content-length");

		// 回传字节流，使用流式响应避免内存占用过大
		const body = upstream.body;
		if (!body) {
			return NextResponse.json(
				{ error: "Empty upstream body" },
				{ status: 502 },
			);
		}

		// 构造响应（同源请求，无需 CORS 头）
		const response = new Response(body, {
			status: 200,
			headers: {
				"Content-Type": contentType,
				...(contentLength ? { "Content-Length": contentLength } : {}),
				"Cache-Control": "no-store",
			},
		});

		return response;
	} catch (error) {
		console.error("Download proxy error:", error);
		return NextResponse.json(
			{ error: "Download proxy failed" },
			{ status: 502 },
		);
	}
}

export const GET = withRoute(getHandler);
