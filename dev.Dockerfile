# syntax=docker/dockerfile:1
# Toolchains for hot reload and local checks in running containers.
FROM node:26.11.1-bookworm-slim AS dev-ui

RUN npm install -g npm@12.2.0 && npm install -g --allow-scripts=pnpm pnpm@12.11.2

ARG DEV_UID=1000
ARG DEV_GID=1000

RUN mkdir -p /home/dev /workspace/ui && chown -R ${DEV_UID}:${DEV_GID} /home/dev /workspace
ENV HOME=/home/dev DO_NOT_TRACK=1 \
  PNPM_CONFIG_STORE_DIR=/home/dev/.local/share/pnpm/store
USER ${DEV_UID}:${DEV_GID}
WORKDIR /workspace/ui
COPY --chown=${DEV_UID}:${DEV_GID} ui/package.json ui/pnpm-lock.yaml ui/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN --network=none pnpm --config.trustLockfile=true rebuild --pending
CMD ["pnpm", "dev"]

FROM golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 AS air
RUN GOTOOLCHAIN=local CGO_ENABLED=0 GOBIN=/out go install -trimpath github.com/air-verse/air@v1.67.4

FROM golang:1.27.2-bookworm@sha256:5cf287a799e6b94384bad13d16b14904c531f51ba65792237e122ce42b392f61 AS dev-go
RUN apt-get update && apt-get install -y --no-install-recommends tmux git curl jq \
  && rm -rf /var/lib/apt/lists/*
COPY --from=air /out/air /usr/local/bin/air
ARG DEV_UID=1000
ARG DEV_GID=1000
RUN mkdir -p /cache /home/dev /run/stt && chown -R ${DEV_UID}:${DEV_GID} /cache /home/dev /run/stt
ENV HOME=/home/dev LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  GOTOOLCHAIN=local GOFLAGS=-mod=vendor GOPROXY=off GOTELEMETRY=off \
  GOCACHE=/cache/go-build GOMODCACHE=/cache/go-mod
WORKDIR /workspace

FROM golangci/golangci-lint:v2.14.0@sha256:ad862ba6b3798cbe0fd9fd7408d498fd74fbd2623a92406b2fd3898faf0bf98f AS lint-tool

FROM dev-go AS dev-server
COPY --from=lint-tool /usr/bin/golangci-lint /usr/local/bin/golangci-lint
USER ${DEV_UID}:${DEV_GID}
ENTRYPOINT ["/bin/bash", "-ec", "mkdir -p /tmp/tmuxde-dev/bin; export TMUXDE_LISTEN=\"$(hostname -i | awk '{print $1}'):24200\"; exec \"$@\"", "tmuxde-dev"]
CMD ["air", "-c", ".air.toml"]

FROM dev-go AS dev-stt
RUN apt-get update && apt-get install -y --no-install-recommends bzip2 \
  && rm -rf /var/lib/apt/lists/*
ARG TARGETARCH
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
  CGO_LDFLAGS="-L/opt/stt/${TARGETARCH}/lib -Wl,--start-group -lsherpa-onnx-c-api -lsherpa-onnx-core -lkaldi-decoder-core -lsherpa-onnx-kaldifst-core -lsherpa-onnx-fstfar -lsherpa-onnx-fst -lkaldi-native-fbank-core -lkissfft-float -lonnxruntime -lssentencepiece_core -Wl,--end-group -lstdc++ -lm -ldl -lpthread"
WORKDIR /workspace
USER ${DEV_UID}:${DEV_GID}
CMD ["air", "-c", "cmd/tmuxde-stt/.air.toml"]
