FROM node:26.11.1-bookworm-slim AS base
LABEL org.opencontainers.image.source="https://github.com/AthennaMind/tmuxde"
LABEL org.opencontainers.image.description="tmuxde speech service - local speech to text for dictation"
LABEL org.opencontainers.image.licenses="MIT"

RUN npm install -g npm@12.2.0 && npm install -g --allow-scripts=pnpm pnpm@12.11.2
WORKDIR /app

# Copy manifests only, so dependency layers survive source edits.
FROM base AS manifests
COPY . .
RUN mkdir /manifests && cp package.json pnpm-lock.yaml pnpm-workspace.yaml /manifests/ \
  && for manifest in apps/*/package.json packages/*/package.json; do install -D -m 644 "$manifest" "/manifests/$manifest"; done

# The speech engine ships as a prebuilt addon. Nothing to build.
FROM base AS installer
COPY --from=manifests /manifests/ .
RUN pnpm install --frozen-lockfile --ignore-scripts --prod --filter "@app/stt..."

# Node runs the TypeScript source directly with type stripping.
FROM node:26.11.1-bookworm-slim AS runner
WORKDIR /app
COPY --from=installer /app/node_modules ./node_modules
COPY --from=installer /app/apps/stt/node_modules ./apps/stt/node_modules
COPY apps/stt/package.json ./apps/stt/
COPY apps/stt/src ./apps/stt/src

USER node
ENV STT_HOST=0.0.0.0 STT_PORT=24400
EXPOSE 24400

HEALTHCHECK --interval=10s --timeout=3s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:24400/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/stt/src/index.ts"]
