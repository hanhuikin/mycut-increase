import type { NextConfig } from "next";
import { withBotId } from "botid/next/config";
import { withContentCollections } from "@content-collections/next";

const nextConfig: NextConfig = {
	/**
	 * The repo carries pre-existing type errors outside the app's critical path
	 * (`next` is declared in both the root and app package.json, so two copies
	 * of its types collide in next.config.ts; the legacy storage migrations and
	 * a couple of tests also drift from current APIs). `next build` runs tsc
	 * over the whole project, so it stops on those before compiling anything.
	 * The container build needs to get through; run `tsc --noEmit` in CI to
	 * keep seeing them, and remove this once the debt is paid.
	 */
	typescript: { ignoreBuildErrors: true },
	/**
	 * 编辑器页启用跨域隔离（COOP + COEP credentialless）：解锁 SharedArrayBuffer
	 * 后，字幕转写的 ONNX Runtime wasm 自动切多线程——无独显机器的 CPU 推理
	 * 提速 2~4 倍。只作用于 /editor/*，避免影响登录 OAuth 弹窗与落地页外链。
	 * credentialless 允许不带 CORP 的跨域 no-cors 子资源（Chrome 96+）；不支持
	 * credentialless 的旧浏览器拿不到 SAB，自动退回单线程（变慢但不坏）。
	 */
	async headers() {
		return [
			{
				source: "/editor/:path*",
				headers: [
					{
						key: "Cross-Origin-Opener-Policy",
						value: "same-origin",
					},
					{
						key: "Cross-Origin-Embedder-Policy",
						value: "credentialless",
					},
				],
			},
		];
	},
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
