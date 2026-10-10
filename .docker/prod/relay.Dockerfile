FROM node:26.11.1-bookworm-slim AS base
LABEL org.opencontainers.image.source="https://github.com/mtmux/mtmux"
LABEL org.opencontainers.image.description="mtmux relay server - WebSocket bridge to tmux sessions"
LABEL org.opencontainers.image.licenses="MIT"

RUN apt-get update && apt-get install -y \
  tmux \
  git \
  python3 \
  make \
  g++ \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g npm@12.2.0 && npm install -g --allow-scripts=pnpm pnpm@12.11.2

FROM base AS pruner
ENV NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
WORKDIR /app
COPY . .
RUN pnpm dlx turbo@2.11.7 prune @app/relay --docker

FROM base AS installer
ENV NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
WORKDIR /app
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN --network=none npm_config_nodedir=/usr/local pnpm --config.trustLockfile=true rebuild --pending

FROM installer AS builder
COPY --from=pruner /app/out/full/ .
RUN pnpm turbo build --env-mode=loose --filter=@app/relay
# Bundle shared TypeScript packages for Node runtime.
RUN pnpm --filter @app/relay run build:bundle

FROM base AS runner
ENV NEXT_TELEMETRY_DISABLED=1 TURBO_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
WORKDIR /app

RUN groupadd -r relay && useradd -r -g relay relay

COPY --from=builder /app/apps/relay/dist ./apps/relay/dist
COPY --from=builder /app/apps/relay/package.json ./apps/relay/
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json .

# pnpm resolves runtime dependencies through package-local symlinks.
COPY --from=builder /app/apps/relay/node_modules ./apps/relay/node_modules

USER relay
ENV RELAY_PORT=24300
EXPOSE 24300

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s \
  CMD node -e "const h=require('http');h.get('http://localhost:24300/health',(r)=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "apps/relay/dist/index.bundle.js"]
