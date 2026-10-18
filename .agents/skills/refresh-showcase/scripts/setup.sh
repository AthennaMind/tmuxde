#!/bin/sh
# Host entry point. Installs TUI tools into the running dev containers and
# builds the demo state. Needs the dev stack up. Safe to rerun.
set -e
DIR=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DIR/../../../.." && pwd)
C="docker compose -f $ROOT/docker-compose.yml"
for svc in server-dev agent-alpha agent-beta; do
  echo "== tools in $svc"
  $C exec -T -u root "$svc" sh -c 'export DEBIAN_FRONTEND=noninteractive; command -v btop >/dev/null && command -v tig >/dev/null && exit 0; apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends htop btop tig vim-tiny >/dev/null'
done
echo "== repositories"
$C exec -T server-dev bash -s < "$DIR/setup-repos.sh"
echo "== sessions"
$C exec -T server-dev bash -s < "$DIR/setup-tmux.sh"
echo "== agents"
$C exec -T agent-alpha bash -s alpha < "$DIR/setup-agent.sh"
$C exec -T agent-beta bash -s beta < "$DIR/setup-agent.sh"
docker image inspect mwader/static-ffmpeg:7.1 >/dev/null 2>&1 || docker pull -q mwader/static-ffmpeg:7.1
