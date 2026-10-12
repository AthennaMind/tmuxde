# Go toolchain for the module at the repository root. Runs offline from
# vendor/. Only the go-vendor service overrides GOPROXY and GOFLAGS to fetch
# modules.

# Build stage for air, the rebuild and restart loop of the server-dev
# service. Only this stage has the module proxy. The final image stays
# offline. air v1.67.4 is the newest release, published 2026-08-01 per
# proxy.golang.org .info, checked 2026-10-12 against the five day delay.
# go install verifies its go.sum against sum.golang.org.
FROM golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 AS air
ARG AIR_VERSION=v1.67.4
RUN GOTOOLCHAIN=local CGO_ENABLED=0 GOBIN=/out \
    go install -trimpath github.com/air-verse/air@${AIR_VERSION}

FROM golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61
# curl runs the server-dev health check over the unix socket.
RUN apt-get update && apt-get install -y --no-install-recommends \
    tmux git ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=air /out/air /usr/local/bin/air
ENV GOTOOLCHAIN=local GOFLAGS=-mod=vendor GOPROXY=off CGO_ENABLED=0 \
    GOCACHE=/workspace/.cache/go-build GOMODCACHE=/workspace/.cache/go-mod \
    GOTMPDIR=/tmp
# Go telemetry stays off. The mode file lives in the image because the
# container root is read-only and HOME is a tmpfs.
ENV XDG_CONFIG_HOME=/usr/local/share/go-config
RUN go telemetry off && cat "$XDG_CONFIG_HOME/go/telemetry/mode"
WORKDIR /workspace
CMD ["go", "version"]
