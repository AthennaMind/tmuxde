# tmuxde speech service. The build stage compiles tmuxde-stt with the cgo
# binding to the sherpa-onnx C API. The runtime image holds the binary and
# the two shared libraries it needs, nothing else.
#
#   docker build -f .docker/prod/stt.Dockerfile -t tmuxde-stt:local .
#
# Pass --build-arg VERSION=x.y.z to set what tmuxde-stt version prints.
# x86_64 only. See internal/stt/README.md.

# Same toolchain as tmuxde.Dockerfile. Builds offline from vendor/.
FROM golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 AS build
ENV GOFLAGS=-mod=vendor GOPROXY=off GOTOOLCHAIN=local
RUN go telemetry off
# tar needs bzip2 for the release tarball. The golang image lacks it.
RUN apt-get update \
  && apt-get install -y --no-install-recommends bzip2 \
  && rm -rf /var/lib/apt/lists/*

# sherpa-onnx v1.13.8 release with headers and shared libraries. The hash
# is checked before anything is unpacked.
ARG SHERPA_ONNX_URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-linux-x64-shared.tar.bz2
ARG SHERPA_ONNX_SHA256=c0bdb7907d3a74bba1d55d22bf4d9fa75586cf1530614ebe88a27b9118e015c4
RUN curl -fsSL --proto '=https' --tlsv1.2 -o /tmp/sherpa-onnx.tar.bz2 "$SHERPA_ONNX_URL" \
  && echo "$SHERPA_ONNX_SHA256  /tmp/sherpa-onnx.tar.bz2" | sha256sum -c - \
  && mkdir -p /opt/sherpa-onnx \
  && tar -xjf /tmp/sherpa-onnx.tar.bz2 -C /opt/sherpa-onnx --strip-components=1 --no-same-owner \
    --wildcards '*/include/*' '*/lib/libsherpa-onnx-c-api.so' '*/lib/libonnxruntime.so' \
  && rm /tmp/sherpa-onnx.tar.bz2 \
  && test -f /opt/sherpa-onnx/include/sherpa-onnx/c-api/c-api.h

WORKDIR /src
COPY go.mod go.sum ./
COPY vendor ./vendor
COPY cmd ./cmd
COPY internal ./internal
ARG VERSION=dev
# The rpath points at where the runtime image puts the libraries.
RUN --network=none CGO_ENABLED=1 \
  CGO_CFLAGS="-I/opt/sherpa-onnx/include" \
  CGO_LDFLAGS="-L/opt/sherpa-onnx/lib -Wl,-rpath,/usr/local/lib/sherpa-onnx" \
  go build -tags sherpa -trimpath -ldflags "-s -w -X main.version=$VERSION" -o /out/tmuxde-stt ./cmd/tmuxde-stt

FROM debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587 AS runner
LABEL org.opencontainers.image.source="https://github.com/AthennaMind/tmuxde"
LABEL org.opencontainers.image.description="tmuxde speech service, local speech to text for dictation"
LABEL org.opencontainers.image.licenses="MIT"

COPY --from=build /opt/sherpa-onnx/lib/libsherpa-onnx-c-api.so /opt/sherpa-onnx/lib/libonnxruntime.so /usr/local/lib/sherpa-onnx/
COPY --from=build /out/tmuxde-stt /usr/local/bin/tmuxde-stt

# Compose sets the host user. Without it, run as an unprivileged user.
USER 65532:65532
# The service listens only on this unix socket. Compose mounts the stt
# subdir of the host run directory here. The tmuxde server dials it.
ENV STT_SOCKET=/run/tmuxde/stt/stt.sock

# GET /health over the socket. There is no TCP listener.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s \
  CMD ["tmuxde-stt", "health"]

CMD ["tmuxde-stt", "serve"]
