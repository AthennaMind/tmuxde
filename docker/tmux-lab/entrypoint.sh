#!/bin/bash
# Seed first, then hand the container over to the real relay.
#
# Order matters. The relay refuses to boot when `tmux -V` fails and would race
# an empty server otherwise, and `tmux-manager.ts` resolves `TMUX_SOCKET` once
# at module load (`config.ts` reads `process.env` at import time) -- so the
# socket has to exist before `node` starts, not merely soon after.
#
# Seeding returns as soon as the sessions exist; the profiles keep producing
# afterwards. The healthcheck, not this script, is what decides "ready".
set -euo pipefail

/lab/seed.sh seed

echo "lab: seeded $( tmux -S "${LAB_SOCKET}" list-sessions | wc -l ) sessions on ${LAB_SOCKET}"

exec node apps/relay/dist/index.bundle.js
