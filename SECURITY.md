# Security Policy

## Supported Versions

| Version                | Supported |
| ---------------------- | --------- |
| latest `mtmux` release | Yes       |
| anything older         | No        |

Only the latest published [`mtmux`](https://www.npmjs.com/package/mtmux) release
and the current `main` are actively supported with security updates.

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly. **Do not
open a public issue.**

Email **security@mtmux.com** with:

- A description of the vulnerability
- Steps to reproduce it
- Which component is affected (CLI, relay, web client, broker, `@repo/crypto`)
- Any relevant logs or screenshots — **redacted**: never include a pairing code,
  an auth token, or a session token

You can also open a private advisory at
[github.com/mtmux/mtmux/security/advisories/new](https://github.com/mtmux/mtmux/security/advisories/new).
Machine-readable contacts are at
[mtmux.com/.well-known/security.txt](https://mtmux.com/.well-known/security.txt).

## Safe harbour

We will not pursue or support legal action against anyone who reports a
vulnerability to us in good faith and follows this policy. Specifically, if you:

- test only against **your own** machines, accounts and pairings — never a third
  party's, and never a code you were given by someone else;
- stop as soon as you have shown the problem exists, and do not access, modify,
  retain, or exfiltrate anyone else's data;
- avoid degrading the service for others (no volumetric denial of service, no
  spam, no destructive testing against the hosted broker); and
- give us reasonable time to fix the issue before disclosing it publicly;

then we consider your research authorised, we will not treat it as a breach of
our terms, and we will say so if a third party asks.

If you are unsure whether something is in scope or would cross one of those
lines, ask first at **security@mtmux.com**. Asking is always in good faith.

## Response Timeline

- **Acknowledgement:** within 48 hours
- **Initial assessment:** within 5 business days
- **Fix or mitigation:** as soon as practical, depending on severity

We will coordinate disclosure with you and credit reporters in the release notes
unless anonymity is requested.

## Reporting abuse

Someone using mtmux to attack you or others — a code sent under a false pretext,
a machine you did not authorise, a relay hosted on our infrastructure that is
being used to reach systems it should not — is an **abuse** report rather than a
vulnerability report. Email **abuse@mtmux.com**, and include timestamps and the
domain or address involved. We can act on hosted pairing and hosted accounts.
We cannot act on a self-hosted install, which by design we cannot see and do not
have access to.

## Threat Surface

mtmux gives a browser a terminal on someone's machine, and since 0.3.0 it also
brokers connections between strangers' devices. Reports touching any of the
following are especially welcome.

### The CLI and relay

- Bypassing the WebSocket auth handshake, or the 5-second auth deadline.
- Escaping `ALLOWED_PATHS`, including via symlinks — the guard resolves symlinks
  on both the target and each allowed root before comparing.
- Command injection through the tmux CLI or the PTY bridge.
- Recovering `AUTH_TOKEN` by timing the comparison, which is SHA-256 digested
  and then `timingSafeEqual`'d.
- Defeating the failed-auth throttle, or using it to lock out a legitimate user.

### Pairing

- **Anything that lets the broker learn the secret half of the code.** It is
  generated locally, is the CPace password, and must never reach the broker —
  not even as a hash. Only the leading slot digits are ever transmitted.
- Getting more than one guess per code. A failed key confirmation destroys the
  mailbox by design; a path that leaves it alive breaks the whole guessing
  bound.
- **Getting an unbounded supply of codes to guess at.** One guess per code only
  bounds anything if the supply of codes is finite. `mtmux start` spends from a
  per-failure budget that nothing but a completed pairing resets, and backs off
  from the fourth wrong code — a way around either is a way back to an unlimited
  online search, whatever the code length.
- Learning whether a pairing is live on a slot without spending a guess. The
  claim endpoint answers identically either way, by design; anything that
  distinguishes them is an enumeration oracle.
- Defeating the claim or mailbox rate limits, including by forging
  `X-Forwarded-For`.
- Pairing a victim's CLI to an attacker's browser, or the reverse.
- Leaking the pairing code out of the URL fragment.

**Known and accepted:** the one-guess bound rests on clients honestly sending
`pair:close` after a failed confirmation. A malicious _holder_ that never closes
keeps its own mailbox alive past a wrong guess. The broker cannot verify a
confirmation it is unable to read — that is the same property that stops it
impersonating either side — so this stays client-enforced. It costs an attacker
nothing they do not already have: the mailbox in question is their own.

### The sealed tunnel

- Any way the broker, or anyone on the path, can read or modify a frame. Frames
  are AES-256-GCM under a **per-connection subkey**: HKDF-SHA-256 from the CPace
  ISK gives a per-direction key, and a 16-byte salt carried on the first frame
  of each stream derives the key actually used, under a label that also
  separates frames from the sealed descriptor. Any construction that lets one
  key seal two payloads at counter 0 is the bug class this replaced, and is
  worth reporting immediately.
- Replay or reorder acceptance. The frame counter must strictly increase and the
  high-water mark must only advance on a frame that authenticates.
- Reaching the relay through a tunnel without a valid pairing — a stream whose
  first frame no key opens must be refused, not forwarded.
- Impersonating a device to the tunnel registry. Registration is a signature
  over a server-issued challenge.
- Errors in the CPace implementation in `packages/crypto/src/cpace.ts`. It is
  checked against the draft's Appendix B.3 vectors, which proves the encoding
  and group maths but not the surrounding protocol wiring. **That wiring has not
  had an independent security review.** Findings there are exactly what we want.

### Hosted accounts

- Forging a session, or session fixation across `app.` and `api.`.
- Escaping a plan limit, or reading another account's servers.

## Out of Scope

- Exposing the CLI's port directly to the internet without TLS. It serves plain
  HTTP by design and the documentation says not to.
- Anything requiring an attacker to already have the machine's `AUTH_TOKEN` or
  local shell access — both are, by construction, full access.
- Denial of service against your own machine by your own client.
