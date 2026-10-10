#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
python3 .docker/dev/setup.py
echo "Setup complete. Run docker compose up -d --build."
