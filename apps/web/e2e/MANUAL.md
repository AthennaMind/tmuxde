# The checklist automation cannot reach

Everything here was considered for Playwright and rejected for a stated reason,
not skipped. Run it before a release that touches auth, the lock, or sharing.

## The lock on a real phone

- [ ] iOS, installed to the home screen. Open the app switcher: the shell is
      blurred in the OS screenshot.
- [ ] With "lock when I switch apps" **on**: the Face ID prompt itself must not
      trigger a lock. This is the loop that makes the setting unusable if the
      ceremony suppression regresses.
- [ ] Kill the app and reopen: locked, every time.
- [ ] Unlock, then reload: locked again. A module variable does not survive a
      reload, and nothing may reintroduce persistence.

## The LAN origin

- [ ] `mtmux start`, open the printed `http://192.168.x.x:14100` URL.
- [ ] Enrolling a PIN works. (`crypto.subtle` is absent here — the AEAD and
      PBKDF2 fallbacks must both engage.)
- [ ] The passkey option says the origin is insecure rather than failing.

## The keyboard, on real hardware

Detection is unit-tested against synthetic viewport samples; the e2e suite only
asserts the CSS contract. Everything below is the part that needs a phone.

- [ ] Pixel (Chrome): focus the command bar. The bottom nav disappears, the
      keyboard toolbar stays — it is the only source of Esc, Tab, arrows and
      `|`, which are needed precisely while typing.
- [ ] Blur it. The nav comes back, once, without flickering.
- [ ] Scroll so the URL bar collapses (~90px). The nav must **not** disappear.
- [ ] Pinch to zoom with the keyboard closed. The nav must **not** disappear.
- [ ] Rotate with the keyboard open, then closed. No stuck state either way.
- [ ] iPhone (Safari): the same, plus — open the composer with the keyboard up
      and confirm the Send button is above the keyboard, not under it.
- [ ] iPhone, composer closed, keyboard closed: the bottom padding clears the
      home indicator.

## `mtmux start` with nobody at the machine

- [ ] Run it under systemd (or `nohup`, or a detached tmux pane) so there is no
      TTY. Press "Pair this device" in the dashboard.
- [ ] The machine's output shows the request, the device, the account and the
      SAS digits, and tells you to run `mtmux approve`.
- [ ] Run `mtmux approve` in another shell within the window: the request is
      handed over, the digits match, approving completes the pairing.
- [ ] Do nothing instead. It denies on timeout, and the browser offers "Ask
      again" — not the refusal copy.

## Approving a device from the app

Automated in `e2e/lab/device-approval.spec.ts` at five viewports on two engines,
against the real relay — except the two halves no emulator has. Both are here
for a stated reason, not skipped.

- [ ] Pair a phone. On a second browser, press "Pair this device" in the
      dashboard for the same machine.
- [ ] The phone shows the prompt _without being touched_, over whatever was on
      screen. **Why manual:** the lab injects the question into a live client;
      it cannot produce a real CPace exchange, because it has no broker and no
      second browser.
- [ ] The six digits on the phone match the six in the requesting browser.
      Deny, and confirm the requesting browser says so rather than sitting
      there.
- [ ] Repeat and approve. The new device lands in the session; the phone shows
      the confirmation, not a stale dialog.
- [ ] With `mtmux start` attached to a terminal, raise a request and answer it
      on the phone. The terminal's `[y/N]` closes by itself and the shell takes
      keystrokes again. **Why manual:** the abort path is unit-tested, but
      "stdin was actually given back" is a property of a real TTY.
- [ ] Two phones connected: answer on one, and the other's dialog closes
      itself.
- [ ] Raise a request and lock the phone until it expires. Unlock: the dialog is
      gone and a notice says it was denied.

## The re-armed code

- [ ] `mtmux start`. Confirm stdout holds the banner and nothing else; the
      relay's log lines are in `mtmux logs`, not on screen.
- [ ] Scan the QR from a phone. The machine prints a **named** device, e.g.
      `✓ Chrome on iOS connected.`, over the "Waiting…" line rather than under it.
- [ ] `mtmux logs -n 50` shows the relay output that used to be on screen.
- [ ] Type a deliberately wrong code three times: each says so gently and a
      fresh code appears immediately.
- [ ] A fourth: the wording changes to name it as guessing, and the replacement
      is five seconds late.

## The code-pairing gate

Automated where it could be: `pairing-exchange.test.ts` proves the descriptor is
never sealed on a refusal, and `device-approval.spec.ts` proves the dialog drops
the digit block rather than emptying it. What is left needs a real broker and a
real second device, which the lab has neither of.

- [ ] `mtmux start`, then scan the QR from a phone. The phone stays on
      "verifying" — **not** an error, and not the terminal — while the machine
      asks. Say yes; the terminal loads.
- [ ] Same again, and say **no** at the machine. The phone shows "did not match,
      or it was refused at the machine", the terminal prints a refusal line, and
      a fresh code appears. Nothing is in `mtmux devices list`.
- [ ] With a phone already connected, scan from a second device. The dialog on
      the first phone asks, with **no digit block** — it is a code pairing, so
      there is nothing to compare.
- [ ] Walk away and let it lapse. The pairing fails; nothing was admitted.
- [ ] `mtmux start` opens no browser. `mtmux start --open` does.

## Known flake

A lab run intermittently dies with Playwright's `Target crashed` — the renderer
process, not an assertion. Roughly 1 test in 30 to 50, and not reproducible on
demand: every spec it has killed passes 27/27 or 54/54 under `--repeat-each` in
isolation, on a box with 86 GB free and a 63 GB `/dev/shm`.

Two things are known about it and both are worth writing down, because each
kills a theory that looks obvious.

- **It is not one project.** First seen only on `lab-tablet`, which made
  SwiftShader the natural suspect — the terminal is the one page holding a live
  WebGL context, and there is no GPU here. Then it took `lab-webkit`, a
  different engine. Whatever it is, it is not Chromium's software GL alone.
- **It is not one spec, but it is one moment.** All four occurrences are in
  `device-approval.spec.ts`, and all four are inside `lab.open()` rather than
  in anything the spec asserts. That file happens to sort first in `e2e/lab`,
  so what those four have in common is being among the first pages a freshly
  launched browser opens — a cold-start shape, not a product one.

Neither observation is a diagnosis and neither is written up as one. What is no
longer a guess is what it looks like: `fixtures.ts` listens for
`page.on("crash")`, records it in `problems` so the sweep fails on it, and makes
`waitFor` say the renderer died — checked both before and after each poll,
because Playwright rejects the in-flight call before the crash event lands. A
crash is still a red run; it is just a legible one, and CI's one retry covers
it.
