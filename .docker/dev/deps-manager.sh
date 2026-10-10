#!/usr/bin/env bash
set -euo pipefail
mkdir -p "$HOME"
cd /workspace
while IFS= read -r -d '' manifest; do
  relative="${manifest#/manifests/}"
  mkdir -p "$(dirname "$relative")"
  cp "$manifest" "$relative"
done < <(find /manifests -type f -print0)
fingerprint="$({
  find /manifests -type f -print0 | sort -z | xargs -0 sha256sum
  sha256sum "$0"
  node --version
  pnpm --version
} | sha256sum | cut -d ' ' -f 1)"
marker=/workspace/node_modules/.mtmux-native-sync
case "${1:-download}" in
  download)
    shift
    if [[ $# == 0 && -f "$marker" && "$(cat "$marker")" == "$fingerprint" ]]; then
      echo 'Dependencies unchanged. Download skipped.'
      exit 0
    fi
    rm -f "$marker"
    pnpm install --frozen-lockfile --ignore-scripts --prefer-offline "$@"
    ;;
  build)
    if [[ -f "$marker" && "$(cat "$marker")" == "$fingerprint" ]]; then
      echo 'Dependencies unchanged. Build skipped.'
      exit 0
    fi
    # Download phase already verified lockfile policy. Rebuild must stay offline.
    pnpm --config.trustLockfile=true rebuild --pending
    printf '%s\n' "$fingerprint" > "$marker"
    ;;
  mutate)
    shift
    rm -f "$marker"
    if [[ "${1:-}" == resolve ]]; then
      shift
      rm pnpm-lock.yaml
      pnpm install --no-frozen-lockfile --ignore-scripts "$@"
    else
      pnpm "$@" --ignore-scripts
    fi
    while IFS= read -r -d '' manifest; do
      relative="${manifest#/manifests/}"
      mkdir -p "/export/$(dirname "$relative")"
      cp "$relative" "/export/$relative"
    done < <(find /manifests -type f -print0)
    ;;
  *)
    echo 'Use download or build' >&2
    exit 2
    ;;
esac
