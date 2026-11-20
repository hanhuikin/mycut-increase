// 把 @huggingface/transformers 自带的 ONNX Runtime wasm 二进制拷进 public/ort/，
// 供 transcription worker 同源加载（worker.ts 里 wasmPaths = "/ort/"）。
// 不这么做的后果：transformers.js 默认 wasmPaths 指向 cdn.jsdelivr.net，
// 国内网络对 jsdelivr 间歇性不可达，转写初始化直接 "Failed to fetch"。
// 模型权重走 env.remoteHost（hf-mirror），wasm 是另一条加载路径，不受其控制。
// 接入点：package.json 的 dev/build/preview/deploy 脚本 + Dockerfile builder 阶段，
// 任何一条构建/开发路径都会先跑本脚本。产物不入库（见 .gitignore）。
import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
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
	let dir = dirname(require.resolve("@huggingface/transformers"));
	for (let i = 0; i < 4 && !distDir; i++) {
		if (
			readdirSync(dir).some((name) => /^ort-wasm-.*\.wasm$/.test(name))
		) {
			distDir = dir;
			break;
		}
		dir = dirname(dir);
	}
}
if (!distDir) {
	console.error(
		`sync-ort-wasm: cannot locate dist with ort-wasm-* (resolved entry: ${require.resolve("@huggingface/transformers")})`,
	);
	process.exit(1);
}

mkdirSync(outDir, { recursive: true });

let copied = 0;
for (const name of readdirSync(distDir)) {
	if (!/^ort-wasm-.*\.(mjs|wasm)$/.test(name)) continue;
	const dest = join(outDir, name);
	if (!statSync(join(distDir, name)).isFile()) continue;
	copyFileSync(join(distDir, name), dest);
	copied++;
}

if (copied === 0) {
	console.error(`sync-ort-wasm: no ort-wasm-* files found in ${distDir}`);
	process.exit(1);
}
console.log(`sync-ort-wasm: copied ${copied} file(s) to public/ort/`);
