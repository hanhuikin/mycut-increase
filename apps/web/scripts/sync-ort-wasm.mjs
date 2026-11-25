// 把 @huggingface/transformers 自带的 ONNX Runtime wasm 二进制拷进 public/ort/，
// 供 transcription worker 同源加载（worker.ts 里 wasmPaths = "/ort/"）。
// 不这么做的后果：transformers.js 默认 wasmPaths 指向 cdn.jsdelivr.net，
// 国内网络对 jsdelivr 间歇性不可达，转写初始化直接 "Failed to fetch"。
// 模型权重走 env.remoteHost（hf-mirror），wasm 是另一条加载路径，不受其控制。
// 接入点：package.json 的 dev/build/preview/deploy 脚本 + Dockerfile builder 阶段，
// 任何一条构建/开发路径都会先跑本脚本。产物不入库（见 .gitignore）。
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
// 包的 exports 未暴露 ./package.json，只能从主入口反推：主入口在 dist/ 里，
// 自该目录向上找第一个含 ort-wasm-* 的目录即为 dist。
const outDir = join(webRoot, "public", "ort");

let distDir;
{
	// v4 起 wasm 不再随 transformers 的 dist 分发，而是它依赖树里的
	// onnxruntime-web（可能与根上其他依赖拉到的版本不同而嵌套）。从
	// transformers 自己的 package.json 出发 resolve，保证拿到它配对的副本；
	// 老版本（wasm 内联在 dist）仍走向上查找兜底。
	const transformersDir = join(
		dirname(require.resolve("@huggingface/transformers")),
		"..",
	);
	const resolveFromTransformers = createRequire(
		join(transformersDir, "package.json"),
	);
	const candidates = [];
	try {
		// ort-web 的 exports 不暴露 ./package.json，解析主入口再取 dist
		const ortEntry = resolveFromTransformers.resolve("onnxruntime-web");
		candidates.push(dirname(ortEntry));
	} catch {
		// transformers 未嵌套 onnxruntime-web（老版本布局）
	}
	let dir = dirname(require.resolve("@huggingface/transformers"));
	for (let i = 0; i < 4 && !candidates.length; i++) {
		if (
			readdirSync(dir).some((name) => /^ort-wasm-.*\.wasm$/.test(name))
		) {
			candidates.push(dir);
			break;
		}
		dir = dirname(dir);
	}
	distDir = candidates.find((dir) =>
		readdirSync(dir).some((name) => /^ort-wasm-.*\.(wasm|mjs)$/.test(name)),
	);
}
if (!distDir) {
	console.error(
		`sync-ort-wasm: cannot locate dist with ort-wasm-* (resolved entry: ${require.resolve("@huggingface/transformers")})`,
	);
	process.exit(1);
}

mkdirSync(outDir, { recursive: true });

// ort-web 1.31 的 web 构建统一走 asyncify 变体（CPU 与 WebGPU EP 都用它，
// 实测页面 resource 计时确认只请求这一对；jsep/jspi/plain 不再被引用）。
const wanted = /^ort-wasm-simd-threaded\.asyncify\.(mjs|wasm)$/;

let copied = 0;
for (const name of readdirSync(distDir)) {
	if (!wanted.test(name)) continue;
	if (!statSync(join(distDir, name)).isFile()) continue;
	copyFileSync(join(distDir, name), join(outDir, name));
	copied++;
}

// 上一次同步留下的、现在不再需要的变体清掉，防止 public/ort 无限增长
for (const name of readdirSync(outDir)) {
	if (/^ort-wasm-/.test(name) && !wanted.test(name)) {
		rmSync(join(outDir, name));
	}
}

if (copied === 0) {
	console.error(`sync-ort-wasm: no ort-wasm-* files found in ${distDir}`);
	process.exit(1);
}
console.log(`sync-ort-wasm: copied ${copied} file(s) to public/ort/`);
