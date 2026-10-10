#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export DEV_UID="$(id -u)" DEV_GID="$(id -g)"
export LAB_WEB_PORT="${LAB_WEB_PORT:-14190}"
export LAB_AUTH_TOKEN="${LAB_AUTH_TOKEN:-mtmux-lab-token-not-for-production}"
lab=(docker compose -f .docker/compose/lab.yaml)
command="${1:-up}"
if (($#)); then shift; fi
case "$command" in
  up)
    python3 .docker/dev/dependencies.py
    docker build -f .docker/lab/Dockerfile -t mtmux-lab:latest .
    "${lab[@]}" up -d --wait --wait-timeout 180
    ;;
  down|logs|ps)
    "${lab[@]}" "$command" "$@"
    ;;
  reset|seed|status)
    "${lab[@]}" exec -T lab /lab/seed.sh "$command" "$@"
    ;;
  test)
    "$0" up
    exec "${lab[@]}" exec -T \
      -e E2E_LAB=1 -e E2E_PORT="$LAB_WEB_PORT" \
      -e E2E_RELAY_TOKEN="$LAB_AUTH_TOKEN" \
      -e NEXT_PUBLIC_RELAY_URL=ws://127.0.0.1:24300 \
      lab pnpm --filter @app/web exec playwright test "$@"
    ;;
  *)
    echo 'Usage: .docker/dev/lab.sh {up|down|logs|ps|reset|seed|status|test}' >&2
    exit 2
    ;;
esac
