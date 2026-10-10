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
ENV NEXT_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1
WORKDIR /app

# Copy manifests only, so dependency layers survive source edits.
FROM base AS manifests
COPY . .
RUN mkdir /manifests && cp package.json pnpm-lock.yaml pnpm-workspace.yaml /manifests/ \
  && for manifest in apps/*/package.json packages/*/package.json; do install -D -m 644 "$manifest" "/manifests/$manifest"; done

FROM base AS installer
COPY --from=manifests /manifests/ .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@app/relay..."
RUN --network=none npm_config_nodedir=/usr/local pnpm --config.trustLockfile=true --filter "@app/relay..." rebuild --pending

FROM installer AS builder
COPY . .
# Bundle shared TypeScript packages for Node runtime.
RUN pnpm --filter @app/relay build

FROM base AS runner
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
