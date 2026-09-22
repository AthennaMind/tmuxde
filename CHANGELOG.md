# Changelog

All notable changes to **mtmux** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions refer to the published [`mtmux`](https://www.npmjs.com/package/mtmux)
npm package (`apps/cli`). Changes elsewhere in the monorepo are listed under the
release that shipped them.

## [Unreleased]

## [0.10.0] — 2026-09-22

### Added

- **The panel carries the live code.** The banner prints one and then the
  session scrolls — three pairings and a handful of connect lines later, the
  one fact you need in order to add a laptop is several screens up. The answer
  used to be `l`, which redraws seventeen rows of QR to show nine digits, and
  which nobody knew about. The panel is the surface that does not scroll, so it
  holds `Code 492 716 384 at app.mtmux.com` above the key bar. On a narrow
  terminal the trailing offer goes first, then the host; the digits are the
  part that cannot be reconstructed from anything else on screen.
- **`t` is offered where the need for it appears.** "On this network only" is
  the sentence that makes somebody decide this product is not for them, and the
  way out of it was printed two paragraphs below, under the addresses — by the
  time the eye gets there the question has already been answered. It now sits
  directly under that sentence, beside the QR.
- **`mtmux devices remove`**, which is what the panel's `r` already called it.
  One act with two names is one act somebody has to look up. `revoke` stays as
  an alias forever: it is in scripts, in older docs, and in the scrollback of
  every terminal that has run it.

### Changed

- **The banner says each address once.** In local mode the code block names the
  best address there is, and the block below it printed the same thing again
  with a label on — two lines the reader has to compare character by character
  to discover they are the same place. A row is dropped when the invite above
  has already named it, and never when it is the last one standing.
- **Nothing the panel draws can be wider than the terminal.** The approval
  screen's answer line was 68 columns wide and had never been measured, so on
  anything narrower it wrapped — and the line that wrapped off the bottom was
  the one telling a human how to say no. Every mode is now swept at five widths
  by a test, and whole clauses are dropped rather than sentences truncated:
  half of "4 paired, not he" is not a fact. The help screen was rewritten to
  fit 40 columns rather than end every line in an ellipsis.
- **Two tabs of one browser are two rows again.** They share a pairing and
  therefore a device id, which both rows used as their key — so every lookup
  matched the first: `d` on the second tab described the first, and a
  confirmation acted on whichever the lookup found.
- **The detail card wraps what a device may do, instead of cutting it.** That
  field is the one somebody reads for a security reason, and "every session ·
  type i…" hides whether it can write to files. The raw user agent is dropped
  below 64 columns, where it was a row reading "Mozilla/5.0 (Macintosh; In…".

### Security

- **A live local code is taken down when a tunnel opens.** A server started
  local-only arms six digits for a day and prints them on its banner. Pressing
  `t` replaces that banner with the hosted one, and the local offer went on
  being claimable with nothing anywhere displaying it — a printed secret that
  is no longer printed. Nothing is lost: a hosted pairing seals this machine's
  LAN candidates into its descriptor, so a browser on the same network still
  races straight to a direct socket.
- **The approval prompt can no longer become a second reader on stdin.** There
  is a window between the tunnel arming a code and the panel appearing below
  the banner. A pairing landing in it was answered by a readline — and then the
  panel started, put the terminal in raw mode and installed its own reader.
  That is the defect this project records paying for once already: a dead
  `[y/N]` eating keystrokes on the machine. The prompt is now bound to the
  panel's takeover as well as to its own question, and a question taken down
  that way reports "could not ask", never a refusal, so it moves on to `mtmux
approve` rather than silently denying.

## [0.9.0] — 2026-09-22

### Changed

- **One key gets rid of a device, and it means it.** The panel offered two:
  `c` closed the socket and `r` un-paired. `c` was sold as the reversible one,
  and it was reversible in the worst way — the device still held a working
  credential and was back within the second, so the list looked untouched and
  the panel looked broken. `r` now removes: the token is revoked, the socket
  closes, the keys leave the tunnel agent's ring, and coming back costs a new
  code and a fresh approval. The confirmation says that before anything
  happens. `c` still lands on the same question, because it is the key people
  learned. A connection with no pairing record — this machine's own token, a
  share — has nothing of ours to forget, so there the offer is to hang up and
  it says plainly that it can come straight back.
- **A new code no longer reprints the whole banner.** Every pairing spends the
  code on screen, and the old answer was to redraw the version header, the QR,
  both addresses and the promise, to report that nine digits had changed. Pair
  three phones and the terminal held four near-identical blocks. The re-arm is
  one line now — the new code, and the offer of a fresh QR, because the one
  above it is stale the moment it prints.
- **The log stopped repeating what the panel already shows.** "3 devices
  connected" was printed after every connect and drawn continuously in the
  panel headline two lines below, which is what made three phones reconnecting
  at boot read as nine events. It is still printed where there is no panel: a
  pipe, a service unit, a short terminal. A pairing is one line rather than
  four, and the trusted-devices notice is one line rather than three.

### Security

- **A removed device loses its tunnel keys, not just its token.** Revoking the
  relay token is what stops it authenticating, and that was already enough for
  it to be _denied_. It was not enough for it to be _gone_: with its keys still
  on the agent's ring it could open a sealed stream, be bound by trial
  decryption, reach loopback and be refused one frame later — a working tunnel
  to a closed door, and a stream the machine kept paying for.

## [0.8.0] — 2026-09-22

### Added

- **Six digits to type in local mode.** `mtmux start` on your own network
  printed a QR, two addresses and a 64-character token, and nothing a person
  could type — so "I cannot scan that" had no answer short of copying hex off a
  screen. It prints a code now, and it works from a phone on the wifi or from
  `http://localhost:PORT` on the machine itself. That last case was the one
  worst served: a box bound to loopback, a laptop with wifi off, anyone over
  SSH. One field takes both kinds of code, because six digits and nine cannot
  be confused and nobody should have to know there are two kinds.
- **Every path asks before it lets a device in.** Scanning the QR on your own
  wifi used to mint a full-grant session token with nobody asked anywhere, on
  the reasoning that being on the network was itself the proof. A network is
  not a person. Local pairing now raises the same question every other path
  raises — the app on a connected phone, the TTY or the live panel, `mtmux
approve` — and silence denies.
- **The device list is every device, not just the connected ones.** The most
  common thing anyone wants to do to a device is get rid of one that is _not_
  here, and until now that meant quitting the server and running `mtmux devices
revoke <id>` with an id you had to go and find. Paired-but-absent devices are
  listed dim, with when each was last seen, and rename and revoke work on them.
- **`e` renames a device, and so does `mtmux devices rename`.** Three rows all
  reading "Chrome on macOS" is a list you cannot act on. A name is yours,
  changes nothing about what the device may do, and never overwrites what the
  browser claimed — the card shows both when they differ.
- **`a` flips "ask again when a device I know comes back", live.** That setting
  is behind nearly every "it let something in without asking me": it had asked,
  once, when that device first paired. The banner now says so beside the
  trusted count, and says what to press.
- **Press `t` in a running `mtmux start` to open the tunnel.** A local-only
  server was a decision you could not revisit: the banner's hint said to run
  `mtmux start --hosted`, which means stopping a server you may already have
  paired a phone to, retyping the command with one flag different, and
  arriving back where you were. `t` does it in place — the banner reprints
  with a nine-digit code and nothing already connected is dropped. It is the
  same tunnel `--hosted` opens, started later. `t` and `n` are never both
  offered: `n` replaces a code that exists, `t` creates the thing that has
  codes at all.
- **`d` (or `enter`) opens a card for one connection.** The row says who is
  here; the card says what it is and what it may do — the session, the
  viewer's screen size, the grant as a sentence, how it reached this machine,
  and the device id in full because that is what `mtmux devices revoke` takes.
  "Reached me" is carried from the upgrade rather than guessed from an
  address, so a tunnelled device and a browser on this machine — both loopback
  — are told apart honestly.
- **A `?` on the phone's keyboard toolbar, with the gestures written down.**
  A press, a pinch, a drag and a swipe each do something useful on the
  terminal and none of them can say so; nothing anywhere admitted they
  existed. The sheet is filtered by your gesture settings, so it never teaches
  one you have switched off.

### Changed

- **`t` is spelled as an offer rather than as a letter.** Opening the tunnel
  from a running local server has been one keypress for a while, sitting in a
  key bar among six other pairs of characters — invisible to anyone who had not
  already been told. The panel says what it does now.
- **The returning-device question goes through the same channels as every other
  question.** It used to open its own readline, which with the live panel up in
  raw mode meant two readers on one stdin and a keystroke going to whichever
  got there first. It also now reaches a phone that is already connected and
  `mtmux approve`, which it never did.
- **`/start` no longer tells a broker-less build there are no pairing codes.**
  There are; they are six digits long and they are redeemed against the machine
  serving the page. Invariant #4 has a code field behind it now.

### Security

- **The local pairing code has a guess budget, and the endpoint has a
  backoff.** Six digits are a small space, so the code is not the thing
  protecting it: five wrong guesses burn the offer and print a fresh one, and
  the endpoint applies the same per-address backoff that guards token
  authentication — five rejections, then 30 seconds doubling to fifteen
  minutes. Without the second, burning and re-arming would simply hand an
  attacker five fresh guesses at a time.
- **`POST /_pair/local` requires `Content-Type: application/json`.** A JSON
  body is not a "simple request", so a cross-origin attempt must preflight and
  this origin answers no preflight. Without it, a page on the open internet
  could spend guesses and burn the code on screen through the browser of
  anybody sitting on your wifi.
- **The offer is burned before the human is asked, not after.** A correct code
  left live while the question sits on screen is a code an attacker can retry
  the instant it is denied.
- **Peer-supplied names are stripped at every terminal render site.** A device
  label is whatever a peer claimed to be, and the live panel drew it beside the
  approval question — ample room for escape sequences that walk the cursor up
  the screen and redraw the question. `sanitizeLabel` was already applied on
  the wire; it is now applied where the text actually reaches a terminal.

- **A connection with no pairing record is named from its user agent.** A
  browser signed in with the machine's own token showed as "A device", so
  three of them were three identical rows. It now reads "Safari on iPhone" —
  and says nothing rather than guessing when it cannot tell, because a
  confident wrong answer is worse than vague when telling connections apart is
  the whole job.
- **Copy mode is the pinned button on the phone, not the composer.** Getting
  text _out_ of a terminal is the thing with no other way in on a phone: the
  pane is a canvas, so there is nothing to press and hold over, and the long
  press there now means "this pane's options". The composer keeps the one-line
  bar and moves to the head of the strip, still ungated on the socket.
- **The banner says the tunnel is sealed, and prints the token again.** It
  never mentioned that any of this is encrypted, on the one surface people
  actually read. In local mode it used to say "no token to type" beside a QR,
  which is a dead end for anything that cannot scan one — a laptop on the same
  wifi, a phone that will not give the browser its camera, a machine you are
  reading over SSH. The token is now printed whenever there is no pairing
  code, which is exactly when it is the only credential a second device can
  use by hand. A hosted invite still suppresses it.

### Fixed

- **A pane unzoomed outside the browser went on being drawn as zoomed.**
  `prefix z` on the machine, a pane killed in another client, a split made in
  your own terminal — none of them reached the web client, because the change
  detector that re-announces a session's windows was built from ids, names,
  order, active flag and pane count, and zoom moves none of them. tmux reports
  `window_layout` as the layout the window will _return to_, byte-identical
  zoomed and unzoomed, so the layout could not stand in for it either. The
  zoom flag and the layout are both part of the signature now, and the pane
  list is published beside the window list — a window listing can only say
  _that_ something moved.
- **A pairing code in a URL fragment is now removed whether or not this
  build can read it.** The strip ran only for a fragment that parsed, which
  was fine until the typed code grew to nine digits — at which point every
  link and QR minted by an older mtmux stopped parsing and started leaving
  its six-digit half, the PAKE password, in the address bar and in history.
  Arriving with an unreadable code is also answered now, with the lengths
  that are accepted, instead of with a blank field and no explanation.
- **"Could not reach the pairing service" now says why, when it can.** A code
  entered on a page `mtmux start` served itself is refused by the broker's
  CORS allow-list before it leaves the browser, and a CORS refusal arrives at
  `fetch` as the same opaque error an offline machine produces — so the
  message blamed a service that was running and left people reloading. It now
  names both origins and points at the two routes that do work: the link the
  terminal printed, or the token for this address. The allow-list itself is
  deliberate; the broker refuses to boot in production with localhost in it.
- **The browser's own long-press menu no longer fights the pane menu.**
  Android answered a press on the terminal with "Copy / Select all / Web
  search" drawn over the sheet, stealing the touch on the way. Refused for
  touch-originated menus only: a right-click on a desktop terminal still gets
  the browser's menu, which is the only way to copy a selection out of a
  canvas there.
- **"Jump to latest output" was covered by the tmux FAB on a phone.** Both
  drew a 44px circle at `right-5` along the bottom of the terminal pane, and
  the FAB won — leaving a 4px sliver of the one control that gets you out of
  the history, which is to say leaving none of it. It has moved one target to
  the FAB's left, and grown from the 36px it shipped at to the 44px floor: a
  miss there lands on the gesture surface and scrolls the history further,
  which is the opposite of what was asked for. It is also no longer a
  focusable control inside the rail's own `role="scrollbar"` — a screen
  reader reached a button whose parent claimed to be a scrollbar — but a
  sibling of it.

## [0.7.2] — 2026-09-20

### Added

- **A live device panel in `mtmux start`.** The command used to append an
  event log — "✓ iPhone connected", "· iPhone disconnected" — which answers
  "what happened" but never "who is on this machine right now". The bottom of
  the screen is now a table of the connections that exist, with their age,
  idle time, session and share scope, and two verbs: `c` closes a socket (it
  may reconnect) and `r` revokes the device (it must pair again). `?` lists
  the keys, `n` arms a fresh code, `l` reprints the banner, `q` quits. One
  writer owns the cursor, so the panel is redrawn rather than restated and the
  scrollback holds only log lines. Off a TTY — a pipe, a service unit,
  `--json`, a terminal under twelve rows — nothing changes and the output
  stays the plain append-only log it was.
- **Long-press a pane on a phone for its own options.** Zoom, focus, resize,
  split and kill, aimed at the pane under the finger rather than at whichever
  one tmux considers active — which is what every other pane control in the
  app is limited to. Only the kill asks for confirmation. The gesture has a
  switch in Settings, and a press that has started to drag is still a scroll.

### Changed

- **`mtmux start` serves this network by default.** The tunnel to
  `app.mtmux.com` is now opt-in: `mtmux start --hosted` for once, or
  `mtmux config set reach hosted` for always. Most sessions are a laptop and a
  phone on the same Wi-Fi, and that case never needed to leave the building.
  `--local` still means exactly what it did.
- **The mobile bottom bar has a pinned start.** Everything in the keyboard
  toolbar sat in one horizontally scrolling strip, so on a 390px phone the
  important things were past a fold most people never find. Text mode — the
  composer, where a command can be read back before it runs — is now pinned
  and always on screen, and in copy mode that slot becomes the way out of it.
  Search, the command palette and copy mode moved ahead of the clipboard
  buttons; the splits and the font size moved to the end, since both are in
  the FAB and the font size is also a pinch.

### Fixed

- **Zoom no longer undoes itself.** `pane:zoom` was a bare toggle against
  whatever pane tmux considered active, and the button that sends it only
  updates when the relay's layout announcement lands — so two taps inside one
  round trip applied two toggles and nothing appeared to happen. It could also
  zoom a pane other than the one tapped. The message now names the pane and
  the state wanted, which makes it idempotent; asking to zoom a second pane
  while one is already zoomed moves the zoom instead of cancelling it.

## [0.7.1] — 2026-09-20

### Changed

- **Entering the pairing code now asks for approval.** Scanning the QR or
  typing the nine digits used to be the approval: you ran the command, you
  were standing there, the code was fresh. But the code is read off one screen
  and typed into another, so what it proves is that somebody _saw_ the
  screen — a shoulder, a shared desk, a screenshot in a chat — and not that
  they are you. Knowledge of the code and consent to the pairing had been
  treated as the same fact. Now every path asks, through the same three
  channels: the in-app dialog on a device already connected, the prompt in
  `mtmux start`'s own terminal, and `mtmux approve`. Whoever answers first
  decides; nobody answering means no. A refusal admits nothing and re-arms a
  fresh code.
- **No digits to compare on the code path, deliberately.** The dialog drops
  the six-digit block rather than filling it, because the nine-digit code
  _was_ the shared secret and there is nothing left to check. Six digits
  nobody can verify would teach the eye to nod at the block — including on the
  dashboard requests where checking it is the entire point.
- **`mtmux start` no longer opens a browser by itself.** `--no-open` is gone;
  `--open` opts in. The command is most often run over SSH, in a detached
  pane, or on a headless box, where launching a browser is at best a stray
  window on whatever machine happened to have a display. The URL and the QR
  are already printed.

## [0.7.0] — 2026-09-20

### Breaking — the 0.7.0 clean break

0.7.0 changes the pairing code, the frame key schedule and the wire version
together, and none of the three is backward compatible. Everyone pairing over
the hosted broker must be on 0.7.0 or later.

- **Pairing codes are nine digits** — `492 716 384`, a three-digit slot the
  broker routes on plus a six-digit secret it never sees. The 0.6.x six-digit
  typed code and the two-digit-slot scan code are both deleted; a 0.6.x code
  is refused rather than misread.
- **Tunnel frames are sealed under a per-connection subkey** derived from a
  16-byte salt carried on the first frame of each direction. A 0.6.x peer
  cannot open a 0.7.0 frame, or the reverse. Existing pairings survive — the
  base session keys in `~/.mtmux/config.json` and IndexedDB are unchanged, so
  **nobody has to pair again**.
- **The pairing protocol carries a version.** `PairNewRequest`,
  `PairClaimRequest` and `PairRequestBody` all require `v`, and the pairing
  sockets carry `?v=`. Below the broker's floor, HTTP answers `426 Upgrade
Required` and the WebSocket upgrade answers a raw `HTTP/1.1 426` before any
  frame is sent.

**Upgrading.** `npm i -g mtmux@latest`. A running 0.6.x CLI keeps its current
tunnel until its agent socket next reconnects, then reports
`This version of mtmux is too old for the pairing service` and stops retrying.
Nothing is lost; the update restores it.

**Self-hosting.** The floor is `API_MIN_PROTOCOL`, not a constant. Set it to
`0` to accept every client, including ones that declare no version at all, and
`API_ADVISORY` to put a line in front of your own users. A self-hosted broker
answers to nobody's release schedule.

### Added

- **Approve a new device from the app.** A browser asking to join a machine now
  raises a prompt on any device already paired with it, showing the device, the
  account and the six-digit SAS to compare — Approve or Deny, one tap. The TTY
  prompt in `mtmux start` and `mtmux approve` are unchanged and are asked at the
  same time; whoever answers first decides, and the losing channel is told to
  stop rather than left holding a dead prompt.

  This closes the gap the product's own premise created: every approval path
  before it assumed you could reach a keyboard on the host, which is precisely
  what mtmux exists to avoid.

  Nothing about what silence means changed. On every channel, in every
  combination, an unanswered request is denied when it expires. A read-only or
  single-session share is never shown the question and cannot answer it —
  admitting a device grants more than such a share holds.

- **Scan-to-connect.** `app.mtmux.com/j` claims the code `mtmux start` prints,
  read from the URL fragment so it never reaches a server. Scanning the QR now
  connects with zero taps and no second command; with no fragment the page falls
  back to a six-digit field. `mtmux pair` remains the browser-initiated
  direction.
- **`GET /v1/version`** — `{ protocol, floor, advisory? }`. The kill switch: a
  broker can name a floor and say something urgent to every running CLI without
  shipping code.
- **`API_MIN_PROTOCOL`** and **`API_ADVISORY`** — the floor and the advisory
  string that `/v1/version` reports. `API_MIN_PROTOCOL=0` disables the floor.
- **`API_TUNNEL_MAX_STREAMS`** (default 16) — concurrent streams per tunnel. A
  `stream:open` past the cap is refused rather than closing the tunnel.
- **Accounts and billing on the broker.** `/api/auth/*`, `/v1/me`,
  `/v1/servers`, `/v1/servers/register`, `/v1/servers/:id/heartbeat`,
  `PATCH`/`DELETE /v1/servers/:id`, `/v1/billing`, `/v1/billing/checkout`,
  `/v1/billing/portal`. All optional: with no `DATABASE_URL` they answer 503 and
  pairing is unaffected. Plan limits live in `packages/config/src/plans.ts`.
- **Documentation rewritten against the source.** The docs site now describes
  the `mtmux` CLI that actually ships. New pages: CLI reference, How pairing
  works, The sealed tunnel, Accounts and multiple servers, `mtmux doctor`. The
  duplicate marketing landing page in `apps/docs` was removed — `/` redirects to
  `/docs`, and mtmux.com (`apps/site`) is the only marketing site.

### Changed

- **A pairing code now buys exactly one online guess.** The fan-out moved from
  the claim POST to the claim socket, and claiming a mailbox is a single atomic
  compare-and-set, so a claim burns the slot only once it has paid for an
  upgrade. `offeredTo`/`offerMailbox`/`burnOffer` are gone with the window they
  described. `PairClaimResponse` is `{ claimId, expiresAt }` — `waiting` and
  `offered` are deleted, because the POST can no longer know either.
- **Claim rate limits are charged at attach, not at POST**, and re-derived from
  the slot space: 4 per slot per minute, 200 globally, plus a cheap 5/min
  per-IP limiter on the POST purely to bound allocation.
- **Paired devices survive a restart.** The token derived with each browser is
  persisted against its peer record and replayed by `mtmux start`, so a restart,
  deploy, crash or reboot no longer un-pairs every phone. Bounded by the 90-day
  peer expiry and `mtmux devices revoke <id>`. LAN-nonce sign-ins are unchanged
  and still memory-only.
- **The sealed descriptor is durable.** It moved from `sessionStorage` to
  IndexedDB alongside the session keys, with a `sessionStorage` mirror for
  synchronous reads, so reloading the browser no longer forces a re-pair.
- **Tunnel ids are stable across agent reconnects**, so a dropped connection no
  longer strands paired browsers. Revocation still surrenders the id.
- `apps/docs` sitemap is generated from the Fumadocs page tree instead of a
  hand-maintained list that had already fallen behind the content directory.

### Fixed

- **The broker could decrypt and forge tunnel frames.** Every hosted pairing
  sealed two payloads under one key at counter 0 — the descriptor and the
  first frame — which is AES-GCM nonce reuse and recovers both the plaintext
  and the authentication key. Frames and descriptors now derive separate
  per-connection subkeys under separate labels, so no key ever seals twice at
  counter 0.
- **The browser's sends are serialised**, so two in one tick can no longer
  reach the wire out of counter order and trip the receiver's replay window.
- `mtmux start` wires the tunnel agent correctly and awaits the tunnel id
  through `onTunnelReady`, so the hosted path works rather than falling back to
  local-only.

## [0.3.0] — 2026

The release that made a phone on cellular work.

### Added

- **`mtmux pair` and the reverse tunnel agent.** A device that cannot reach your
  machine pairs with a six-digit code and its session rides a sealed tunnel. The
  agent holds one outbound socket to the broker and bridges sealed frames to a
  loopback relay socket, so no relay internals are touched and the machine's
  `AUTH_TOKEN` never crosses the tunnel.
- **`@repo/crypto`.** CPace (`CPACE-RISTR255-SHA512`, checked against the
  draft's published test vectors), an HKDF-SHA-256 key schedule with one label
  per purpose, AES-256-GCM sealed frames with per-direction nonces and a
  monotonic counter that rejects replays, Ed25519 device keys, and the
  slot+secret pairing code.
- **The blind pairing broker (`apps/api`).** Mailboxes indexed by a two-digit
  slot, claim fan-out, tunnel registry with byte and time quotas, and per-address
  rate limits that carry part of the security argument rather than being
  capacity management. It never sees the four-digit secret and holds no key that
  can open a frame.
- **Pairing and tunnel message schemas** in `@repo/protocol`, kept as a separate
  discriminated union from the relay protocol.
- **Sealed transport and the pairing page** in the web client, with direct
  candidate racing that only counts a candidate as reachable once it completes
  the relay auth handshake.
- **Scoped session tokens and failed-auth throttling** in the relay. A LAN QR
  sign-in redeems a single-use nonce for a 24-hour, memory-only session token,
  so the long-lived token is never typed and never crosses the network. Repeated
  failures from one address lock out with exponential backoff.
- **Accounts, optional.** `mtmux login`/`logout`/`whoami`/`servers`/`upgrade`
  via OAuth device authorization, so a headless box can sign in. Anonymous
  pairing is unaffected and always will be.
- **`mtmux doctor`, `mtmux status`, `mtmux stop`, `mtmux devices`.**
- **`pnpm dev:pairing`**, `pnpm build:hosted`, `pnpm prepare:standalone` and
  `pnpm deploy:hosted` for the hosted topology.

### Changed

- **`mtmux start` binds the LAN by default.** It now picks `0.0.0.0` when the
  machine has a usable private address on a non-virtual interface, and
  `127.0.0.1` when it does not. The old fixed `127.0.0.1` default made the
  phone-on-the-couch case — the whole point of the tool — require a restart with
  `--host 0.0.0.0`. An explicit `--host` still wins.
- **The startup banner** leads with a scannable code instead of a token.
- **Next.js 16 and React 19.2** across the monorepo.
- **Single-port serving with dev parity.** `pnpm dev` runs the same topology
  `mtmux start` ships, so single-port bugs surface while you work.

### Fixed

- The sealed tunnel now actually carries relay traffic.
- A stray build environment variable can no longer reach a published artifact.
- Unpublishable workspace dependencies are no longer shipped, and deploys verify
  themselves before reloading.
- `pnpm build` works under Next 16.

## Earlier

Before 0.3.0 the package was published as `tmuxremote`, and earlier still the
repository carried `ccremote` branding. Upgrading is safe: the CLI adopts a
token found at `~/.tmuxremote/config.json` rather than issuing a new one, so
bookmarked login URLs keep working.

[Unreleased]: https://github.com/mtmux/mtmux/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/mtmux/mtmux/releases/tag/v0.3.0
