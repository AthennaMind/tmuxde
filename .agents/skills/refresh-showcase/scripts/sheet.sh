#!/bin/sh
# Contact sheet of a recorded GIF, one tile every two seconds, for review.
# Usage: scripts/sheet.sh <scene>   -> $TMPDIR/tmuxde-showcase/frames/sheet-<scene>.png
set -e
ROOT=$(cd "$(dirname "$0")/../../../.." && pwd)
WORK=${TMPDIR:-/tmp}/tmuxde-showcase
mkdir -p "$WORK/frames"
docker run --rm -u "$(id -u):$(id -g)" -v "$WORK:/work" -v "$ROOT/.local/showcase:/out" -w /work mwader/static-ffmpeg:7.1 \
  -hide_banner -loglevel error -y -i "/out/$1.gif" \
  -vf "fps=0.5,scale=640:-1,tile=3x5:padding=6:color=gray" -frames:v 1 "frames/sheet-$1.png"
echo "$WORK/frames/sheet-$1.png"
