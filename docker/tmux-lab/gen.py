#!/usr/bin/env python3
"""
The lab's output profiles.

Each subcommand is one *shape* of terminal output chosen to break a different
part of an emulator. They are generated rather than replayed from fixtures for
one reason: a fixture file is a snapshot of whatever the machine that recorded
it happened to produce, and this needs to be byte-identical on every machine
and every run. Everything random here comes from `random.Random(SEED)` with a
fixed seed, so two runs produce the same bytes in the same order.

Written to stdout with explicit flushes. Python line-buffers a pipe, and tmux
gives a pane a pty rather than a pipe, but the profiles that matter most here
are exactly the ones where "when did that byte arrive" *is* the assertion --
so nothing is left to the buffering policy.
"""

import os
import random
import sys
import time

SEED = 20260920


def out() -> "object":
    return sys.stdout.buffer


def w(data: bytes) -> None:
    out().write(data)
    out().flush()


def env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, "") or default)
    except ValueError:
        return default


# --------------------------------------------------------------------------
# firehose -- unbounded output, as fast as the pipe will take it.
#
# This is the profile that is expected to *find* something. The live path in
# `terminal-view.tsx` writes every `terminal:output` message to xterm the
# instant it arrives, while `cast-player.tsx` paces recording playback into
# 1 MiB chunks using xterm's write-callback as backpressure. The slower device
# is the one without the batching, which is backwards. This produces the load
# that proves it.
# --------------------------------------------------------------------------
def firehose() -> None:
    lps = env_int("LAB_FIREHOSE_LPS", 5000)
    burst = max(1, lps // 50)  # 50 bursts a second
    rnd = random.Random(SEED)
    words = [
        "".join(rnd.choice("abcdefghijklmnopqrstuvwxyz") for _ in range(8))
        for _ in range(64)
    ]
    n = 0
    while True:
        chunk = []
        for _ in range(burst):
            n += 1
            chunk.append(
                b"[%08d] %s %s %s\n"
                % (
                    n,
                    words[n % 64].encode(),
                    words[(n * 7) % 64].encode(),
                    words[(n * 13) % 64].encode(),
                )
            )
        w(b"".join(chunk))
        time.sleep(0.02)


# --------------------------------------------------------------------------
# drip -- one line a second, forever.
#
# The opposite failure mode. A connection that is idle for minutes is where a
# reconnect, a stale-cell repaint or a silently dead socket shows up, and none
# of that is visible under load.
# --------------------------------------------------------------------------
def drip() -> None:
    n = 0
    while True:
        n += 1
        w(b"drip %06d  %s\n" % (n, time.strftime("%H:%M:%S").encode()))
        time.sleep(1.0)


# --------------------------------------------------------------------------
# colors -- every SGR attribute, the 256 palette, and a truecolour ramp.
# --------------------------------------------------------------------------
def colors() -> None:
    buf = [b"=== SGR attributes ===\n"]
    for code, name in (
        (1, b"bold"),
        (2, b"dim"),
        (3, b"italic"),
        (4, b"underline"),
        (5, b"blink"),
        (7, b"reverse"),
        (8, b"hidden"),
        (9, b"strike"),
    ):
        buf.append(b"\x1b[%dm%-10s\x1b[0m " % (code, name))
    buf.append(b"\n\n=== 16 ===\n")
    for i in range(16):
        buf.append(b"\x1b[48;5;%dm  \x1b[0m" % i)
    buf.append(b"\n\n=== 256 ===\n")
    for i in range(16, 232):
        buf.append(b"\x1b[48;5;%dm  \x1b[0m" % i)
        if (i - 15) % 36 == 0:
            buf.append(b"\n")
    buf.append(b"\n\n=== greys ===\n")
    for i in range(232, 256):
        buf.append(b"\x1b[48;5;%dm  \x1b[0m" % i)
    buf.append(b"\n\n=== truecolour ===\n")
    for row in range(4):
        for col in range(72):
            r = (col * 255) // 71
            g = (row * 255) // 3
            b = 255 - r
            buf.append(b"\x1b[48;2;%d;%d;%dm \x1b[0m" % (r, g, b))
        buf.append(b"\n")
    buf.append(b"\n=== fg on bg pairs ===\n")
    for fg in range(8):
        for bg in range(8):
            buf.append(b"\x1b[3%d;4%dmAa\x1b[0m" % (fg, bg))
        buf.append(b"\n")
    w(b"".join(buf))


# --------------------------------------------------------------------------
# unicode -- grapheme width, which is what `Unicode11Addon` is loaded for.
#
# The ruler rows are the assertion: if a wide character is measured as one cell
# the column markers stop lining up, and that is visible to `fidelity.ts` as a
# column offset rather than as a vague "looks wrong".
# --------------------------------------------------------------------------
def unicode_profile() -> None:
    rows = [
        "ruler   |....5...10....5...20....5...30",
        "ascii   |the quick brown fox jumps over",
        "cjk     |你好世界こんにちは世界",
        "hangul  |안녕하세요 세계",
        "emoji   |\U0001f600\U0001f680\U0001f9ea\U0001f4a1\U0001f6a8",
        "zwj     |\U0001f468‍\U0001f469‍\U0001f467‍\U0001f466 "
        "\U0001f469‍\U0001f4bb \U0001f3f3️‍\U0001f308",
        "skin    |\U0001f44d\U0001f3fb\U0001f44d\U0001f3fd\U0001f44d\U0001f3ff",
        "combine |é à ô ñ ü å",
        "rtl     |مرحبا שלום",
        "box     |┌─┬─┐ │ └─┴─┘",
        "braille |⠁⠃⠇⠏⠟⠿⣿",
        "vs      |❤️ ❤︎ ✈️ ✈︎",
        "ruler   |....5...10....5...20....5...30",
    ]
    w(("\n".join(rows) + "\n").encode("utf-8"))


# --------------------------------------------------------------------------
# progress -- carriage returns and partial-line repaint.
# --------------------------------------------------------------------------
def progress() -> None:
    spinner = "|/-\\"
    step = 0
    while True:
        pct = step % 101
        filled = pct // 2
        w(
            b"\r[%s%s] %3d%%  %s"
            % (
                b"#" * filled,
                b"." * (50 - filled),
                pct,
                spinner[step % 4].encode(),
            )
        )
        if pct == 100:
            w(b"\n")
        step += 1
        time.sleep(0.05)


# --------------------------------------------------------------------------
# longlines -- lines far wider than any viewport under test.
#
# A correction worth stating, because it changes what this profile can prove.
# tmux composites server-side: the client receives one linear ANSI stream of
# tmux's own rendering, already wrapped to the session's width. A 4000-column
# line therefore never reaches the browser as 4000 columns, and this profile
# cannot manufacture horizontal overflow inside the terminal by brute force --
# `capture-pane` on this session tops out at the session width, not at 4000.
#
# What it does exercise is the *reflow*. The session is created at 400 columns
# while detached; the moment a phone attaches, tmux rewraps every one of these
# lines to ~40, which is the widest possible reflow in the shortest possible
# time. That path -- the debounced fit ladder in `terminal-view.tsx` -- is what
# `reflow.ts` asserts, and it has no end-to-end coverage today.
# --------------------------------------------------------------------------
def longlines() -> None:
    rnd = random.Random(SEED + 1)
    alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
    buf = []
    for i in range(12):
        body = "".join(rnd.choice(alphabet) for _ in range(4000 - 12))
        buf.append(("L%03d " % i) + body)
    # A ruler every 10 columns, so a wrap that lands in the wrong place is
    # legible in a screenshot rather than only in a diff.
    ruler = "".join(str(c // 10 % 10) for c in range(4000))
    buf.append(ruler)
    w(("\n".join(buf) + "\n").encode())


# --------------------------------------------------------------------------
# ctrlseq -- cursor addressing, scroll regions, clears, OSC, bell.
# --------------------------------------------------------------------------
def ctrlseq() -> None:
    b = []
    b.append(b"\x1b[2J\x1b[H")               # clear, home
    b.append(b"\x1b]0;mtmux lab ctrlseq\x07")  # OSC title
    for row in range(1, 20):
        b.append(b"\x1b[%d;%dHrow %02d" % (row, (row * 3) % 40 + 1, row))
    b.append(b"\x1b[5;1H\x1b[K cleared to EOL")
    b.append(b"\x1b[8;1H\x1b[1J")            # clear to start of screen
    b.append(b"\x1b[10;20r")                 # scroll region
    b.append(b"\x1b[10;1H")
    for i in range(30):
        b.append(b"scroll region line %02d\n" % i)
    b.append(b"\x1b[r")                      # reset region
    b.append(b"\x1b[22;1Hsaved\x1b7 moved\x1b[24;40Hhere\x1b8 restored\n")
    b.append(b"\x07")                        # bell
    b.append(b"\x1b[?25l hidden cursor \x1b[?25h shown\n")
    w(b"".join(b))


# --------------------------------------------------------------------------
# garbage -- bytes that are not valid UTF-8.
#
# Escape (0x1b) and BEL (0x07) are filtered out on purpose. The assertion is
# "malformed *text* must not corrupt the screen or crash the renderer"; leaving
# real control introducers in would make it "random escape sequences do
# something unpredictable", which is not a defect anyone can act on.
# --------------------------------------------------------------------------
def garbage() -> None:
    rnd = random.Random(SEED + 2)
    chunks = []
    for i in range(40):
        raw = bytes(
            c
            for c in (rnd.randrange(0x80, 0x100) for _ in range(60))
            if c not in (0x1B, 0x07)
        )
        chunks.append(b"G%02d " % i + raw + b"\n")
    # A truncated multi-byte sequence split across two writes: the emulator has
    # to hold the partial sequence rather than render a replacement character
    # and then a stray byte.
    chunks.append(b"split \xe4\xb8")
    w(b"".join(chunks))
    time.sleep(0.2)
    w(b"\x96 <- that should read as a single CJK glyph\n")


# --------------------------------------------------------------------------
# scrollback -- 50k lines, pre-filled.
# --------------------------------------------------------------------------
def scrollback() -> None:
    lines = env_int("LAB_SCROLLBACK_LINES", 50000)
    step = 2000
    for start in range(0, lines, step):
        w(
            b"".join(
                b"history line %06d of %06d\n" % (i + 1, lines)
                for i in range(start, min(start + step, lines))
            )
        )
    w(b"--- end of seeded history ---\n")


COMMANDS = {
    "firehose": firehose,
    "drip": drip,
    "colors": colors,
    "unicode": unicode_profile,
    "progress": progress,
    "longlines": longlines,
    "ctrlseq": ctrlseq,
    "garbage": garbage,
    "scrollback": scrollback,
}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        sys.stderr.write("usage: gen.py <%s>\n" % "|".join(sorted(COMMANDS)))
        raise SystemExit(2)
    try:
        COMMANDS[sys.argv[1]]()
    except (BrokenPipeError, KeyboardInterrupt):
        raise SystemExit(0)
