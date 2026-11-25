#!/usr/bin/env node
// next build 会在模块求值阶段用 zod 校验 DATABASE_URL / BETTER_AUTH_SECRET /
// REDIS_URL（src/env/web.ts），缺一个整个构建直接失败。容器构建由 Dockerfile
// 在 RUN 命令上内联注入，不走这里；本地或 CI 直接跑 `npm run build` 时，由
// 这个包装器现场生成一次性随机 stub 注入子进程——仓库里不落任何凭据字面量
// （Sonar secrets:S6698 的教训）。调用方已 export 的变量原样透传，绝不覆盖。
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const nextBin = require.resolve("next/dist/bin/next");

const secret = randomBytes(24).toString("hex");
const stubs = {
	DATABASE_URL: `postgresql://build:${secret}@localhost:5432/build`,
	BETTER_AUTH_SECRET: secret,
	REDIS_URL: `redis://:${secret}@localhost:6379`,
};
for (const [key, value] of Object.entries(stubs)) {
	if (!process.env[key]) {
		process.env[key] = value;
	}
}

// shell 仅 Windows 需要（PATH 上解析 node.exe）；stdio 直通保留 next 的
// 彩色进度输出，失败时以 next 的退出码退出，不吞错误。
const result = spawnSync("node", [nextBin, "build"], {
	stdio: "inherit",
	env: process.env,
	shell: process.platform === "win32",
});
process.exit(result.status ?? 1);
