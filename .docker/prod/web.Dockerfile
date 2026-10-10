FROM node:26.11.1-alpine AS base
LABEL org.opencontainers.image.source="https://github.com/mtmux/mtmux"
LABEL org.opencontainers.image.description="mtmux web client - your tmux sessions in any browser"
LABEL org.opencontainers.image.licenses="MIT"

RUN apk add --no-cache wget
RUN npm install -g npm@12.2.0 && npm install -g --allow-scripts=pnpm pnpm@12.11.2
ENV NEXT_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
WORKDIR /app

# Copy manifests only, so dependency layers survive source edits.
FROM base AS manifests
COPY . .
RUN mkdir /manifests && cp package.json pnpm-lock.yaml pnpm-workspace.yaml /manifests/ \
  && for manifest in apps/*/package.json packages/*/package.json; do install -D -m 644 "$manifest" "/manifests/$manifest"; done

# Install web dependencies plus root TypeScript used by Next type checking.
FROM base AS installer
COPY --from=manifests /manifests/ .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@app/web..." --filter .
RUN --network=none npm_config_nodedir=/usr/local pnpm --config.trustLockfile=true --filter "@app/web..." --filter . rebuild --pending

# Build self-contained local web client.
FROM installer AS builder
ENV NEXT_DIST_DIR=.next
ARG NEXT_PUBLIC_RELAY_URL=""
ENV NEXT_PUBLIC_RELAY_URL=$NEXT_PUBLIC_RELAY_URL
COPY . .
RUN pnpm --filter @app/web build

# Runner stage
FROM node:26.11.1-alpine AS runner
ENV NEXT_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
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
