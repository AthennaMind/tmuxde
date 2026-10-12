FROM node:26.11.1-bookworm-slim AS base
LABEL org.opencontainers.image.source="https://github.com/AthennaMind/tmuxde"
LABEL org.opencontainers.image.description="tmuxde speech service, local speech to text for dictation"
LABEL org.opencontainers.image.licenses="MIT"

RUN npm install -g npm@12.2.0 && npm install -g --allow-scripts=pnpm pnpm@12.11.2
WORKDIR /app

# Copy manifests only, so dependency layers survive source edits.
FROM base AS manifests
COPY . .
RUN mkdir /manifests && cp package.json pnpm-lock.yaml pnpm-workspace.yaml /manifests/ \
  && for manifest in ui/package.json stt/package.json packages/*/package.json; do install -D -m 644 "$manifest" "/manifests/$manifest"; done

# The speech engine ships as a prebuilt addon. Nothing to build.
FROM base AS installer
COPY --from=manifests /manifests/ .
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter "@app/stt..."

# Node runs the TypeScript source directly with type stripping.
FROM node:26.11.1-bookworm-slim AS runner
WORKDIR /app
COPY --from=installer /app/node_modules ./node_modules
COPY --from=installer /app/stt/node_modules ./stt/node_modules
COPY stt/package.json ./stt/
COPY stt/src ./stt/src

USER node
# The service listens only on this unix socket. Compose mounts the stt
# subdir of the host run directory here. The tmuxde server dials it.
ENV STT_SOCKET=/run/tmuxde/stt/stt.sock

# GET /health over the socket. There is no TCP listener.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s \
  CMD node -e "process.getBuiltinModule('node:http').get({socketPath:process.env.STT_SOCKET,path:'/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "stt/src/index.ts"]
