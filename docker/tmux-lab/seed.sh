#!/bin/bash
# Seed the lab's tmux population, and answer the healthcheck.
#
#   seed.sh seed    create every session (idempotent: a no-op if they exist)
#   seed.sh reset   kill the server and seed again, for a clean slate
#   seed.sh check   exit 0 only when the relay answers *and* all sessions exist
#   seed.sh status  print what is there, one line per session
#
# Thirteen sessions, each one an *output profile* picked to break a different
# part of a terminal emulator. The table in the plan is the rationale; the
# comments here are only for the ones whose tmux mechanics are non-obvious.
set -euo pipefail

SOCKET="${LAB_SOCKET:-/run/lab/tmux.sock}"
CONF="${LAB_CONF:-/lab/tmux.conf}"
WORK="${LAB_WORK:-/lab/work}"
GEN="${LAB_GEN:-/lab/gen.py}"
PORT="${RELAY_PORT:-24300}"

# Every session name, in creation order. `check` counts against this, so adding
# a profile here is the only edit needed to make the healthcheck demand it.
SESSIONS=(
  idle
  drip
  colors
  unicode
  progress
  longlines
  ctrlseq
  garbage
  altscreen
  many-windows
  many-panes
  firehose
  scrollback
)

tm() { tmux -S "$SOCKET" -f "$CONF" "$@"; }

# A profile that prints and exits would leave a dead pane, and a dead pane
# cannot be typed into -- which half the detectors need to do. So every profile
# hands over to an interactive shell when it is done, and the pane stays live.
gen_then_shell() { printf 'python3 %s %s; exec bash' "$GEN" "$1"; }

have_session() { tm has-session -t "=$1" 2>/dev/null; }

seed() {
  mkdir -p "$WORK"

  # The alternate-screen fixture. `less` needs something long enough to scroll
  # and wide enough to matter.
  if [ ! -s "$WORK/altscreen.txt" ]; then
    python3 "$GEN" scrollback >"$WORK/altscreen.txt" 2>/dev/null || true
  fi
  # A small tree for the file-browser surfaces to have something real to show.
  mkdir -p "$WORK/src" "$WORK/docs"
  printf 'lab fixture\n' >"$WORK/README.md"
  printf 'export const answer = 42;\n' >"$WORK/src/answer.ts"
  printf '# notes\n\nseeded by the lab.\n' >"$WORK/docs/notes.md"

  # --- the simple one-pane profiles ------------------------------------
  have_session idle      || tm new-session -d -s idle      -c "$WORK" -x 120 -y 40
  have_session drip      || tm new-session -d -s drip      -c "$WORK" -x 120 -y 40 "$(gen_then_shell drip)"
  have_session colors    || tm new-session -d -s colors    -c "$WORK" -x 120 -y 40 "$(gen_then_shell colors)"
  have_session unicode   || tm new-session -d -s unicode   -c "$WORK" -x 120 -y 40 "$(gen_then_shell unicode)"
  have_session progress  || tm new-session -d -s progress  -c "$WORK" -x 120 -y 40 "$(gen_then_shell progress)"
  have_session ctrlseq   || tm new-session -d -s ctrlseq   -c "$WORK" -x 120 -y 40 "$(gen_then_shell ctrlseq)"
  have_session garbage   || tm new-session -d -s garbage   -c "$WORK" -x 120 -y 40 "$(gen_then_shell garbage)"

  # Wider than any viewport under test on purpose: a 4000-column line that tmux
  # had already wrapped at 120 would be testing tmux's wrapping, not the
  # client's horizontal overflow.
  have_session longlines || tm new-session -d -s longlines -c "$WORK" -x 400 -y 40 "$(gen_then_shell longlines)"

  # --- alternate screen -------------------------------------------------
  # The one profile where xterm's own scrollback is necessarily empty, because
  # tmux owns the alternate buffer. That is the entire reason the scroll rail
  # and the `tmux:scroll*` messages exist, so it needs its own session.
  if ! have_session altscreen; then
    tm new-session -d -s altscreen -c "$WORK" -x 120 -y 40 "less -R $WORK/altscreen.txt"
    tm new-window -t altscreen: -n top -c "$WORK" "top -d 1"
    tm select-window -t altscreen:0
  fi

  # --- many windows -----------------------------------------------------
  # Twelve, because `window-tabs.tsx` has to overflow at 390px for the strip
  # logic to be worth asserting at all.
  if ! have_session many-windows; then
    tm new-session -d -s many-windows -n w00 -c "$WORK" -x 120 -y 40
    for i in $(seq -w 1 11); do
      tm new-window -t many-windows: -n "w$i" -c "$WORK" \
        "printf 'window %s\\n' $i; exec bash"
    done
    tm select-window -t many-windows:0
  fi

  # --- many panes -------------------------------------------------------
  if ! have_session many-panes; then
    tm new-session -d -s many-panes -n tiled -c "$WORK" -x 200 -y 50
    for i in 1 2 3 4 5; do
      tm split-window -t many-panes:tiled -c "$WORK" "printf 'pane %s\\n' $i; exec bash"
      tm select-layout -t many-panes:tiled tiled
    done
    tm select-layout -t many-panes:tiled tiled
    tm new-window -t many-panes: -n columns -c "$WORK"
    for i in 1 2 3; do
      tm split-window -t many-panes:columns -h -c "$WORK" "printf 'col %s\\n' $i; exec bash"
    done
    tm select-layout -t many-panes:columns even-horizontal
    tm select-window -t many-panes:tiled
    tm select-pane -t many-panes:tiled.0
  fi

  # --- the two heavy ones, last ----------------------------------------
  # `history-limit` is read when a pane is created, not when it scrolls, so the
  # global has to move before this session exists and back again after. Leaving
  # it raised would put all thirteen on ~60k lines of retained scrollback.
  if ! have_session scrollback; then
    tm set-option -g history-limit 60000
    tm new-session -d -s scrollback -c "$WORK" -x 120 -y 40 "$(gen_then_shell scrollback)"
    tm set-option -g history-limit 10000
  fi

  have_session firehose || tm new-session -d -s firehose -c "$WORK" -x 120 -y 40 "$(gen_then_shell firehose)"
}

reset() {
  tm kill-server 2>/dev/null || true
  rm -f "$SOCKET"
  seed
}

check() {
  for s in "${SESSIONS[@]}"; do
    have_session "$s" || { echo "missing session: $s" >&2; return 1; }
  done
  # The scrollback profile is the slow one; "healthy" must mean its history is
  # actually there, or a spec that scrolls races the seeding.
  #
  # `#{history_size}` rather than counting `capture-pane` output. `-t` takes a
  # *pane* target here, and the `=name` exact-match prefix that `has-session`
  # accepts is not one -- `capture-pane -t "=scrollback"` answers "can't find
  # pane", which piped into `wc -l` reads as a plausible-looking zero and made
  # this check fail forever against a session that was in fact fully seeded.
  local lines
  lines=$(tm display-message -p -t scrollback '#{history_size}' 2>/dev/null || echo 0)
  if [ "${lines:-0}" -lt 1000 ]; then
    echo "scrollback still filling ($lines lines)" >&2
    return 1
  fi
  node -e "
    const h = require('http');
    h.get('http://127.0.0.1:${PORT}/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))
     .on('error', () => process.exit(1));
  "
}

status() {
  printf '%-14s %-8s %-7s %s\n' SESSION WINDOWS PANES CREATED
  tm list-sessions -F '#{session_name}	#{session_windows}	#{session_created}' |
    while IFS=$'\t' read -r name windows created; do
      panes=$(tm list-panes -s -t "$name" | wc -l)
      printf '%-14s %-8s %-7s %s\n' "$name" "$windows" "$panes" "$created"
    done
  echo
  echo "expected ${#SESSIONS[@]} sessions; socket $SOCKET"
}

case "${1:-seed}" in
  seed) seed ;;
  reset) reset ;;
  check) check ;;
  status) status ;;
  *) echo "usage: $0 {seed|reset|check|status}" >&2; exit 2 ;;
esac
