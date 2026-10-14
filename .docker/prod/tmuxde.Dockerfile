# tmuxde single binary. The web stage builds the React app in src/ui, the go
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

# Install the dependencies of the React app in src/ui, then build its dist.
# Manifests come first, so dependency layers survive source edits.
FROM web-base AS web
COPY src/ui/package.json src/ui/pnpm-lock.yaml src/ui/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN --network=none npm_config_nodedir=/usr/local pnpm --config.trustLockfile=true rebuild --pending
COPY src/ui .
RUN --network=none pnpm build

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
COPY --from=web /app/dist ./web/dist
# A build without index.html would serve 503 on every page. Fail here.
RUN test -f web/dist/index.html
ARG VERSION=dev
RUN --network=none go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o /out/tmuxde ./cmd/tmuxde

FROM scratch AS binary
COPY --from=go /out/tmuxde /tmuxde
