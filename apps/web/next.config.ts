import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";
import { withContentCollections } from "@content-collections/next";

const nextConfig: NextConfig = {
	// The repo's historical type debt is paid off: `tsc --noEmit` is clean, so
	// `next build` no longer needs to skip type checking.
	// 曾经为字幕转写开启跨域隔离（COOP + COEP）以解锁 SharedArrayBuffer 让
	// ONNX Runtime wasm 走多线程，但实测多线程会挂起会话创建（详见
	// services/transcription/worker.ts 的 numThreads 注释），worker 现在固定
	// 单线程，隔离已无收益，反而会让 credentialless 下的跨域资源更容易被拦，
	// 因此整体移除。
	compiler: {
		// Production strips stray console.* debugging from the bundle, but
		// error/warn survive: the structured logger (services/logging/) and
		// crash dumps must keep working in every environment — 本地、test、
		// prod 都要求有日志输出。The logger itself emits through bound
		// console references, so the strip does not silence it.
		removeConsole:
			process.env.NODE_ENV === "production"
				? { exclude: ["error", "warn"] }
				: false,
	},
	reactStrictMode: true,
	productionBrowserSourceMaps: true,
	output: "standalone",
	images: {
		remotePatterns: [
			{
				protocol: "https",
				hostname: "plus.unsplash.com",
			},
			{
				protocol: "https",
				hostname: "images.unsplash.com",
			},
			{
				protocol: "https",
				hostname: "images.marblecms.com",
			},
			{
				protocol: "https",
				hostname: "lh3.googleusercontent.com",
			},
			{
				protocol: "https",
				hostname: "avatars.githubusercontent.com",
			},
			{
				protocol: "https",
				hostname: "api.iconify.design",
			},
			{
				protocol: "https",
				hostname: "api.simplesvg.com",
			},
			{
				protocol: "https",
				hostname: "api.unisvg.com",
			},
			{
				protocol: "https",
				hostname: "cdn.brandfetch.io",
			},
		],
	},
};

export default withContentCollections(withBotId(nextConfig));
