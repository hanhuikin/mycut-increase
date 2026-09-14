/**
 * 火山方舟 Seedance 2.0 连通性测试脚本
 *
 * 用法:
 *   node script/test-ark.mjs
 *
 * 脚本会:
 *   1. 校验 NEXT_PUBLIC_ARK_API_KEY 是否存在
 *   2. 创建视频生成任务 (POST /contents/generations/tasks)
 *   3. 轮询任务状态直到完成/失败/超时 (最长 5 分钟)
 *   4. 输出视频 URL
 *
 * 注意: 需要 Node 18+ (原生 fetch)。脚本在 Windows 上用 bash 跑。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 读取 apps/web/.env.local 中的 NEXT_PUBLIC_ARK_API_KEY
function loadEnv() {
	const envPath = path.join(__dirname, "..", "apps", "web", ".env.local");
	const raw = fs.readFileSync(envPath, "utf8");
	const env = {};
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
		const idx = trimmed.indexOf("=");
		const key = trimmed.slice(0, idx).trim();
		let value = trimmed.slice(idx + 1).trim();
		// 去掉包裹的引号
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		env[key] = value;
	}
	return env;
}

const env = loadEnv();
const ARK_API_KEY = env.NEXT_PUBLIC_ARK_API_KEY;

if (!ARK_API_KEY) {
	console.error("❌ 未找到 NEXT_PUBLIC_ARK_API_KEY。请检查 apps/web/.env.local");
	process.exit(1);
}

const ARK_BASE = "https://ark.cn-beijing.volces.com/api/v3";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function createTask({ prompt, duration, resolution, aspectRatio }) {
	const res = await fetch(`${ARK_BASE}/contents/generations/tasks`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${ARK_API_KEY}`,
		},
		body: JSON.stringify({
			model: "doubao-seedance-2-0-260128",
			content: [{ type: "text", text: prompt }],
			ratio: aspectRatio,
			duration: 5,
			resolution: resolution,
			generate_audio: false,
		}),
	});

	if (!res.ok) {
		const errText = await res.text();
		throw new Error(`创建任务失败 (${res.status}): ${errText}`);
	}
	const json = await res.json();
	if (!json.id) {
		throw new Error(`创建任务返回异常: ${JSON.stringify(json)}`);
	}
	return json.id;
}

async function pollTask(taskId) {
	const res = await fetch(`${ARK_BASE}/contents/generations/tasks/${taskId}`, {
		headers: { Authorization: `Bearer ${ARK_API_KEY}` },
	});
	if (!res.ok) {
		throw new Error(`查询任务失败 (${res.status})`);
	}
	return await res.json();
}

async function main() {
	const prompt = "一只柯基犬在草地上奔跑，阳光明媚，镜头跟随，动态感强";
	const duration = "5";
	const resolution = "720p";
	const aspectRatio = "16:9";

	console.log("=== 火山方舟 Seedance 2.0 连通性测试 ===");
	console.log(`API Key: ${ARK_API_KEY.slice(0, 8)}...${ARK_API_KEY.slice(-6)}`);
	console.log(`Prompt : ${prompt}`);
	console.log(`参数   : duration=${duration}, resolution=${resolution}, ratio=${aspectRatio}`);
	console.log("");

	// 1. 创建任务
	const taskId = await createTask({ prompt, duration, resolution, aspectRatio });
	console.log(`✅ 任务创建成功: ${taskId}`);
	console.log("开始轮询状态...\n");

	// 2. 轮询状态（最长 5 分钟，每 2 秒一次）
	const maxAttempts = 150;
	const startTime = Date.now();
	for (let i = 0; i < maxAttempts; i++) {
		await sleep(2000);
		const task = await pollTask(taskId);

		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		const status = task.status;

		if (status === "succeeded" || status === "completed") {
			const videoUrl = task.content?.[0]?.video_url;
			console.log(`✅ 生成成功（耗时 ${elapsed}s）`);
			if (videoUrl) {
				console.log(`🎬 视频地址: ${videoUrl}`);
			} else {
				console.warn("⚠️ 任务成功但未返回 video_url");
			}
			console.log("\n完整响应:");
			console.log(JSON.stringify(task, null, 2));
			process.exit(0);
		}

		if (status === "failed" || status === "cancelled") {
			console.error(`❌ 任务状态: ${status}`);
			console.error(`错误: ${JSON.stringify(task.error ?? task)}`);
			process.exit(1);
		}

		// 每 5 次打一次进度
		if (i % 5 === 0) {
			console.log(`  [${elapsed}s] 状态: ${status}`);
		}
	}

	console.error(`❌ 超时（超过 5 分钟），最后状态: ${JSON.stringify(await pollTask(taskId))}`);
	process.exit(1);
}

main().catch((err) => {
	console.error("❌ 测试失败:", err.message);
	process.exit(1);
});
