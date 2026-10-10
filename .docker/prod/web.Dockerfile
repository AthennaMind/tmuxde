FROM node:26.11.1-alpine AS base
LABEL org.opencontainers.image.source="https://github.com/mtmux/mtmux"
LABEL org.opencontainers.image.description="mtmux web client - your tmux sessions in any browser"
LABEL org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache wget
RUN npm install -g npm@12.2.0 && npm install -g --allow-scripts=pnpm pnpm@12.11.2
ENV NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
WORKDIR /app

# Prune stage
FROM base AS pruner
COPY . .
RUN pnpm dlx turbo@2.11.7 prune @app/web --docker

# Install stage
FROM base AS installer
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN --network=none npm_config_nodedir=/usr/local pnpm --config.trustLockfile=true rebuild --pending

# Build self-contained local web client.
FROM installer AS builder
ENV NEXT_DIST_DIR=.next
ARG NEXT_PUBLIC_RELAY_URL=""
ENV NEXT_PUBLIC_RELAY_URL=$NEXT_PUBLIC_RELAY_URL
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo build --env-mode=loose --filter=@app/web

# Runner stage
FROM node:26.11.1-alpine AS runner
ENV NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache wget
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/apps/web/.next/standalone ./
COPY --from=builder /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /app/apps/web/public ./apps/web/public
USER nextjs
EXPOSE 24100
ENV PORT=24100

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget --spider -q http://localhost:24100/ || exit 1

CMD ["node", "apps/web/server.js"]
