FROM oven/bun:alpine AS base

FROM base AS builder

WORKDIR /app

# Railway 会把服务变量作为 build arg 传入,覆盖本地默认值
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000

COPY package.json package.json
COPY bun.lock bun.lock
COPY turbo.json turbo.json

COPY apps/web/package.json apps/web/package.json
RUN bun install

COPY apps/web/ apps/web/

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Build-time env stubs to pass zod validation. REDIS_URL mirrors the runtime
# schema (ioredis direct — the old UPSTASH_REST_* pair predates that switch
# and fails env parsing now). Values here are placeholders: nothing connects
# during `next build`, and the runner overrides everything from its env.
ENV DATABASE_URL="postgresql://opencut:opencut@localhost:5432/opencut"
ENV BETTER_AUTH_SECRET="build-time-secret"
ENV REDIS_URL="redis://:build-time@localhost:6379"
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL

WORKDIR /app/apps/web
RUN bun run build

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

CMD ["bun", "apps/web/server.js"]
