#!/usr/bin/env bash
# Kill all mtmux dev processes and free ports
set -euo pipefail

PORTS=(14100 14102 14300)
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# Kill any orphaned dev processes from this repo
orphans=$(ps aux | grep "$SCRIPT_DIR" | grep -E "next dev|tsx watch|scripts/dev\.mjs" | grep -v grep | awk '{print $2}' || true)
if [ -n "$orphans" ]; then
  echo "Killing orphaned dev processes..."
  echo "$orphans" | xargs kill -9 2>/dev/null || true
fi

# Kill anything still holding our ports
for port in "${PORTS[@]}"; do
  pids=$(lsof -ti :"$port" 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "Killing port $port (PID: $pids)"
    echo "$pids" | xargs kill -9 2>/dev/null || true
  fi
done

echo "All ports cleared."
