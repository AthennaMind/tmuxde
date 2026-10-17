# syntax=docker/dockerfile:1

FROM --platform=$BUILDPLATFORM node:26.11.1-bookworm-slim AS ui-build
RUN npm install -g npm@12.2.0 && npm install -g --allow-scripts=pnpm pnpm@12.11.2
ENV DO_NOT_TRACK=1
WORKDIR /src/ui
COPY src/ui/package.json src/ui/pnpm-lock.yaml src/ui/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN --network=none pnpm --config.trustLockfile=true rebuild --pending
COPY src/ui/ ./
RUN --network=none pnpm exec vite build --configLoader native

FROM --platform=$BUILDPLATFORM golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 AS tmuxde-source
ARG TARGETOS
ARG TARGETARCH
ENV GOTOOLCHAIN=local GOFLAGS=-mod=vendor GOPROXY=off GOTELEMETRY=off
WORKDIR /src
COPY go.mod go.sum ./
COPY vendor/ vendor/
COPY cmd/ cmd/
COPY internal/ internal/
COPY web/ web/
# web/embed.go embeds this UI into binary during compilation.
COPY --from=ui-build /src/ui/dist/ web/dist/
ARG VERSION=dev
RUN --network=none CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags "-s -w -buildid= -X main.version=$VERSION" -o /out/tmuxde ./cmd/tmuxde

FROM golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 AS stt-source
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends curl jq bzip2 \
    && rm -rf /var/lib/apt/lists/*
ENV GOTOOLCHAIN=local GOFLAGS=-mod=vendor GOPROXY=off GOTELEMETRY=off
COPY cmd/tmuxde-stt/assets.json /opt/stt/assets.json
WORKDIR /opt/stt
SHELL ["/bin/bash", "-euo", "pipefail", "-c"]
RUN <<'EOF'
mkdir -p include/sherpa-onnx/c-api "$TARGETARCH"
curl --fail --location --retry 3 "$(jq -r '.header.url' assets.json)" -o include/sherpa-onnx/c-api/c-api.h
echo "$(jq -r '.header.sha256' assets.json)  include/sherpa-onnx/c-api/c-api.h" | sha256sum --check
curl --fail --location --retry 3 "$(jq -r --arg arch "$TARGETARCH" '.libraries[$arch].url' assets.json)" -o libraries.tar.bz2
echo "$(jq -r --arg arch "$TARGETARCH" '.libraries[$arch].sha256' assets.json)  libraries.tar.bz2" | sha256sum --check
tar -xjf libraries.tar.bz2 -C "$TARGETARCH" --strip-components=1 --wildcards '*/lib/*.a'
rm libraries.tar.bz2
EOF
# Upstream ARM64 C API includes TTS. Rebuild it for speech recognition only.
RUN <<'EOF'
if [ "$TARGETARCH" = arm64 ]; then
  jq -r '.c_api_sources | to_entries[] | [.key, .value.url, .value.sha256] | @tsv' assets.json |
  while IFS=$'\t' read -r name url checksum; do
    mkdir -p "$name"
    curl --fail --location --retry 3 "$url" -o "$name.tar.gz"
    echo "$checksum  $name.tar.gz" | sha256sum --check
    tar -xzf "$name.tar.gz" -C "$name" --strip-components=1
    rm "$name.tar.gz"
  done
  jq -r '.c_api_headers | to_entries[] | [.key, .value.url, .value.sha256] | @tsv' assets.json |
  while IFS=$'\t' read -r name url checksum; do
    mkdir -p "$(dirname "include/$name")"
    curl --fail --location --retry 3 "$url" -o "include/$name"
    echo "$checksum  include/$name" | sha256sum --check
  done
  g++ -std=c++17 -O2 -DNDEBUG -D_GLIBCXX_USE_CXX11_ABI=1 \
    -DSHERPA_ONNX_ENABLE_TTS=0 -DSHERPA_ONNX_ENABLE_SPEAKER_DIARIZATION=0 \
    -Isource -Iinclude -Ikaldi-decoder -Ikaldifst -Iopenfst/src/include -Ieigen \
    -c source/sherpa-onnx/c-api/c-api.cc -o arm64/c-api.cc.o
  rm arm64/lib/libsherpa-onnx-c-api.a
  ar rcs arm64/lib/libsherpa-onnx-c-api.a arm64/c-api.cc.o
  rm -rf source kaldi-decoder kaldifst openfst eigen arm64/c-api.cc.o
fi
EOF
RUN <<'EOF'
mkdir -p models
jq -r '.models | to_entries[] | [.key, .value.url, .value.sha256] | @tsv' assets.json |
while IFS=$'\t' read -r name url checksum; do
  curl --fail --location --retry 3 "$url" -o "models/$name"
  echo "$checksum  models/$name" | sha256sum --check
done
EOF
ENV CGO_ENABLED=1 CGO_CFLAGS=-I/opt/stt/include \
    CGO_LDFLAGS="-Wl,-z,noexecstack -L/opt/stt/${TARGETARCH}/lib -Wl,--start-group -lsherpa-onnx-c-api -lsherpa-onnx-core -lkaldi-decoder-core -lsherpa-onnx-kaldifst-core -lsherpa-onnx-fstfar -lsherpa-onnx-fst -lkaldi-native-fbank-core -lkissfft-float -lonnxruntime -lssentencepiece_core -Wl,--end-group -lstdc++ -lm -ldl -lpthread"
WORKDIR /src
COPY go.mod go.sum ./
COPY vendor/ vendor/
COPY cmd/ cmd/
COPY internal/ internal/
# Models become command-owned embedded assets in standalone binary.
RUN cp -a /opt/stt/models cmd/tmuxde-stt/internal/bundle/models \
    && jq -cS '.models | map_values(.sha256)' /opt/stt/assets.json > cmd/tmuxde-stt/internal/bundle/models/manifest.json
ARG VERSION=dev
RUN --network=none go build -tags 'sherpa stt_bundle netgo osusergo' -trimpath \
    -ldflags "-s -w -buildid= -X main.version=$VERSION -linkmode external -extldflags -static" \
    -o /out/tmuxde-stt ./cmd/tmuxde-stt

FROM gcr.io/distroless/static-debian13:nonroot@sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3 AS tmuxde-stt
COPY --from=stt-source /out/tmuxde-stt /usr/local/bin/tmuxde-stt
COPY docs/stt-notices.md /usr/share/doc/tmuxde-stt/NOTICE.md
ENV HOME=/home/nonroot XDG_CACHE_HOME=/home/nonroot/.cache STT_SOCKET=/tmp/stt.sock
USER 65532:65532
HEALTHCHECK --start-period=120s --interval=10s --timeout=3s CMD ["/usr/local/bin/tmuxde-stt", "health"]
ENTRYPOINT ["/usr/local/bin/tmuxde-stt"]
CMD ["serve"]

FROM alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0 AS tmuxde
RUN apk add --no-cache tmux git bash ca-certificates \
    && addgroup -g 65532 tmuxde \
    && adduser -D -u 65532 -G tmuxde -h /home/tmuxde -s /bin/bash tmuxde \
    && mkdir /workspace && chown tmuxde:tmuxde /workspace
COPY --from=tmuxde-source /out/tmuxde /usr/local/bin/tmuxde
ENV HOME=/home/tmuxde \
    ALLOWED_PATHS=/workspace \
    TMUX_DEFAULT_SHELL=/bin/bash \
    TMUXDE_TMUX_LAUNCHER=none \
    TMUXDE_LISTEN=unix:/home/tmuxde/http.sock
WORKDIR /workspace
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/tmuxde"]
CMD ["serve"]
