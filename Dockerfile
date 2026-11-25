# Bun installs dependencies (fast, bun.lock); Node runs `next build` and the
# standalone server. Bun 1.2.18 segfaults during Next's "collecting page data"
# worker fan-out (`worker_threads` options are unimplemented) and lacks
# WebAssembly.instantiateStreaming at runtime, so it is a package manager here
# only — Node is Next's supported runtime.
# 国内构建：底座走公司 Harbor 内部镜像（uat 项目里镜像化的 bun 底座，内网直连
# 最快且不受公网镜像源波动影响），apk 走阿里云源，依赖走 npmmirror。
# 底座换源时可覆盖（官方源需能连 Docker Hub）：
#   docker build --build-arg BASE_IMAGE=oven/bun:1.2.18-alpine .
ARG BASE_IMAGE=harbor.sunwin-sh.com/uat/bun:1.2.18-alpine
FROM ${BASE_IMAGE} AS base

# Alpine 官方源切到阿里云镜像（apk 换源后才能装 nodejs）
# apk upgrade：底座镜像自带的 libssl3/libcrypto3 3.3.3-r0 命中 CVE-2026-31789
# （CRITICAL 9.8，X.509 大 OCTET STRING 堆溢出），升级到当前分支最新补丁版；
# 顺带把底座里其他过期包一起升级，减少镜像层 CVE。
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories \
	&& apk upgrade --no-cache \
	&& apk add --no-cache nodejs

FROM base AS builder

WORKDIR /app

# Railway 会把服务变量作为 build arg 传入,覆盖本地默认值
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
# NEXT_PUBLIC_* 被内联进客户端代码，必须在构建期存在。取帧性能埋点开关：
# =1 时客户端日志放开 DEBUG 并输出取帧 decode/encode 耗时，默认关闭。
ARG NEXT_PUBLIC_DEBUG_FRAMES=""

COPY package.json package.json
COPY bun.lock bun.lock
COPY turbo.json turbo.json

COPY apps/web/package.json apps/web/package.json
# bun.lock 不记录 registry URL，依赖源完全由此环境变量决定
ENV BUN_CONFIG_REGISTRY=https://registry.npmmirror.com
RUN bun install

COPY apps/web/ apps/web/

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
ENV NEXT_PUBLIC_DEBUG_FRAMES=$NEXT_PUBLIC_DEBUG_FRAMES

WORKDIR /app/apps/web
# Dockerfile 直接调 next build（不走 package.json 脚本），ORT wasm 同步需单独执行：
# 转写 worker 同源加载 public/ort/ 下的 wasm，绕开被墙的 cdn.jsdelivr.net
RUN node scripts/sync-ort-wasm.mjs
# Build-time env stubs to pass zod validation. REDIS_URL mirrors the runtime
# schema (ioredis direct — the old UPSTASH_REST_* pair predates that switch
# and fails env parsing now). Values are placeholders: nothing connects during
# `next build`, and the runner takes everything from its own env.
# 凭据字面量一律不写死：现场用 node:crypto 生成一次性随机串。之前这里是
# postgresql://opencut:opencut@...，被 Sonar secrets:S6698 判为 BLOCKER。
# 全程用 export + 分号分隔：变量必须以 export 内建命令落到进程环境，不依赖
# 「独立赋值行跨 && 持久化」这种不同 sh 实现行为不一的写法（Harbor 底座的
# busybox ash 就不持久化，曾导致 next build 里 process.env 三个变量全为
# undefined）。
RUN export BUILD_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(24).toString('hex'))")"; \
	BIN=./node_modules/next/dist/bin/next; \
	if [ ! -f "$BIN" ]; then BIN=../../node_modules/next/dist/bin/next; fi; \
	export DATABASE_URL="postgresql://build:${BUILD_SECRET}@localhost:5432/build" \
		BETTER_AUTH_SECRET="${BUILD_SECRET}" \
		REDIS_URL="redis://:${BUILD_SECRET}@localhost:6379"; \
	node "$BIN" build

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

RUN chown nextjs:nodejs apps

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "apps/web/server.js"]
