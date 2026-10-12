# tmuxde single binary. The web stage builds the React app in ui/, the go
# stage embeds it and compiles a static binary, and binary holds only that
# file.
#
#   docker build -f .docker/prod/tmuxde.Dockerfile --target binary --output type=local,dest=.docker/bin .
#
# The binary lands in .docker/bin/tmuxde. Pass --build-arg VERSION=x.y.z to
# set what tmuxde version prints.

FROM node:26.11.1-alpine@sha256:143494b1da2945f061539253adc65e4f1569ddf07da2d384c022c791a9d90a4a AS web-base
RUN npm install -g npm@12.2.0 && npm install -g --allow-scripts=pnpm pnpm@12.11.2
ENV DO_NOT_TRACK=1
WORKDIR /app

# Copy manifests only, so dependency layers survive source edits.
FROM web-base AS manifests
COPY . .
RUN mkdir /manifests && cp package.json pnpm-lock.yaml pnpm-workspace.yaml /manifests/ \
  && for manifest in ui/package.json stt/package.json packages/*/package.json; do install -D -m 644 "$manifest" "/manifests/$manifest"; done

# Install ui dependencies plus root tooling, then build ui/dist.
FROM web-base AS web
COPY --from=manifests /manifests/ .
RUN pnpm install --frozen-lockfile --ignore-scripts --filter "@app/ui..." --filter .
RUN --network=none npm_config_nodedir=/usr/local pnpm --config.trustLockfile=true --filter "@app/ui..." --filter . rebuild --pending
COPY . .
RUN --network=none pnpm --filter @app/ui build

# Same toolchain as .docker/dev/go.Dockerfile. Builds offline from vendor/.
FROM golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 AS go
ENV CGO_ENABLED=0 GOFLAGS=-mod=vendor GOPROXY=off GOTOOLCHAIN=local
RUN go telemetry off
WORKDIR /src
COPY go.mod go.sum ./
COPY vendor ./vendor
COPY cmd ./cmd
COPY internal ./internal
COPY web ./web
# .dockerignore keeps every dist out of the context, so this is the only
# web build the embed sees.
COPY --from=web /app/ui/dist ./web/dist
# A build without index.html would serve 503 on every page. Fail here.
RUN test -f web/dist/index.html
ARG VERSION=dev
RUN --network=none go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o /out/tmuxde ./cmd/tmuxde

FROM scratch AS binary
COPY --from=go /out/tmuxde /tmuxde
