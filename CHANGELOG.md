# Changelog

All notable changes to **mtmux** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions refer to the published [`mtmux`](https://www.npmjs.com/package/mtmux)
npm package (`apps/cli`). Changes elsewhere in the monorepo are listed under the
release that shipped them.

## [Unreleased]

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
