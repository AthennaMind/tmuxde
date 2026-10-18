#!/bin/sh
# Pushes .local/showcase media to the public AthennaMind/tmuxde-assets repo.
# docs/SHOWCASE.md links by file name, so unchanged names keep working.
set -e
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
OUT="$ROOT/.local/showcase"
ASSETS=${TMUXDE_ASSETS_DIR:-${TMPDIR:-/tmp}/tmuxde-assets}
if [ -d "$ASSETS/.git" ]; then
  git -C "$ASSETS" pull -q --ff-only
else
  git clone -q git@github.com:AthennaMind/tmuxde-assets.git "$ASSETS"
fi
mkdir -p "$ASSETS/showcase"
cp "$OUT"/*.gif "$OUT"/*.mp4 "$OUT"/*.png "$ASSETS/showcase/"
git -C "$ASSETS" add -A
if git -C "$ASSETS" diff --cached --quiet; then echo "nothing to publish"; exit 0; fi
NAME=$(git -C "$ROOT" config user.name); EMAIL=$(git -C "$ROOT" config user.email)
git -C "$ASSETS" -c "user.name=$NAME" -c "user.email=$EMAIL" commit -q -m "docs: refresh showcase media"
git -C "$ASSETS" push -q
git -C "$ASSETS" log --oneline -1
