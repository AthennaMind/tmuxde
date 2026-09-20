# The checklist automation cannot reach

Everything here was considered for Playwright and rejected for a stated reason,
not skipped. Run it before a release that touches auth, the lock, or sharing.

## Conditional UI (passkey autofill)

`signIn.passkey({ autoFill: true })` puts credentials into the browser's own
autofill dropdown. **That dropdown is not scriptable** — not by Playwright's
locators and not by CDP's `WebAuthn` domain, which can create a virtual
authenticator but cannot open the browser's UI chrome. So:

- [ ] macOS Safari — focus the email field on `/signin`; a passkey suggestion
      appears in the dropdown; choosing it signs in.
- [ ] Chrome desktop — same.
- [ ] iOS Safari — same, via Face ID.
- [ ] Move from the email step to any other step. The prompt must **abandon**;
      Safari otherwise leaves a stuck ceremony that blocks the next one.

## The read-only escape

This is the one that matters most, and no unit test reaches it — it is a
property of tmux, not of our code.

- [ ] `mtmux share work --read-only`, join from a second browser.
- [ ] In the read-only browser, press `(`, `)`, `prefix s`, `prefix :`,
      `prefix d`. **Nothing may happen.** `(` and `)` are bound to
      `switch-client` by default and still work under `attach-session -r`,
      which is why read-only attaches to a locked clone instead.
- [ ] Type into it. Nothing reaches the PTY.
- [ ] Meanwhile the owner's own client keeps its prefix key and bindings — the
      clone sets _session_ options, so it must not have touched them.

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

## End to end, on the box

- [ ] `pnpm dev:pairing`, real phone against the real broker.
- [ ] `echo $((6*7))` through the sealed tunnel.
- [ ] `grep` the broker log for any session name, code, slot or mailbox id.
      **Expect zero hits.**

## Dictation

Real dictation cannot be asserted in headless Chromium: there is no supported
way to inject a transcript, and `--use-fake-device-for-media-stream` feeds
`getUserMedia`, which is a different code path from the Web Speech service. The
reducer, the capability detection and the transliteration are unit-tested
instead; what is left is the half that only exists on a device.

- [ ] Android Chrome over https: tap the mic, say "git checkout dash b
      feature slash login". The field shows `git checkout -b feature/login`,
      the caret sits after it, and **nothing runs**.
- [ ] iOS Safari, as a tab: the same.
- [ ] iOS, installed to the home screen: recognition frequently starts and then
      never fires anything at all. Expect the watchdog message ("Dictation did
      not start. Try the browser instead of the app.") rather than a button
      that spins forever.
- [ ] Deny the microphone. The button reports it and **stays** reporting it —
      tapping again must not re-prompt, because a denial only clears in browser
      settings.
- [ ] Grant it again from browser settings, reload, and dictate. Works.
- [ ] Airplane mode, then tap the mic: the message is about the connection, and
      the permission prompt never appears.
- [ ] On the LAN origin (`http://192.168.x.x:14100`): the button is disabled and
      says dictation needs https, rather than doing nothing.
- [ ] Firefox: the button is **absent**, not disabled.
- [ ] Start dictating, then switch apps. The microphone stops.

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
