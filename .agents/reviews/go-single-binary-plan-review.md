# Go single binary plan review

Date 2026-10-12. Plan: `.agents/plans/go-single-binary.md`. Backlog: `.agents/plans/backlogs/go-single-binary-backlog.md`. Grounded against relay, web, protocol, compose files and host state. Plan and backlog left untouched pending decisions below.

Verdict: plan is sound. Go, embedded SPA, TLS from existing CA, stt kept in Node, hand written Go types with shared fixtures. All correct calls. Four changes recommended: flip phase order so Go lands before Vite, run as user unit with sysctl instead of system unit, vendor Go modules, cut dead upstream code from scope now instead of "if audit allows". Audit is done, results below.

## What the code says

Inherited upstream code audit. Standalone relay never installs any upstream hook. `armLocalPairing`, `setLocalPairingGate`, `setConnectionGate`, `askDeviceApproval` have no non-test callers. Live relay surface is three entry points: WebSocket on `/_relay`, `GET /file`, `GET /health`.

| Item | Reachable with token login | Verdict |
| --- | --- | --- |
| `/_pair/local`, `/_pair/session`, `/_pair/revoke` | No offer ever armed, loopback only routes answer 403 through Caddy | Drop |
| `pair:*`, `tunnel:*`, `stream:*` messages (22 types) | Not in `ClientMessage` union, relay answers INVALID_MESSAGE | Drop |
| Scoped grants, `policy.ts` | Token always gets `FULL_GRANT`. Only pane and window ownership check (`policy.ts:238-257`) does work | Keep ownership rule only |
| Device approval, connection gate | `connection-gate.ts:70` returns true with no gate. Relay never sends approval request | Drop |
| `SealedTransport` | Only built in `session-census.ts` from tests. `ws-client.ts:129` always direct | Drop |
| Read only clones | `session:attach` with `grant.readOnly`, never true. Name filter `__tmuxde_` and startup sweep still run | Keep filter and sweep, drop creation |
| `GET /_sessions` | Loopback plus token, 403 through Caddy, no web caller | Drop |
| `auth` message | `{type, token}` in, `auth:success {serverVersion, capabilities, features}` plus `server:info` out | Port |

Bug found on the way. `/_pair/local` 401 calls `recordAuthFailure` (`server.ts:160`). Throttle keys on `req.socket.remoteAddress`, which is Caddy's container IP. Five stale `/login#n=` loads lock token login for every client. Go binary sees real addresses and has no `/_pair`, so this disappears.

Sizes:

| Relay code to port | about 5.7k TS lines |
| --- | --- |
| Relay code dropped | about 1.8k TS lines |
| Relay tests to port | about 3.6k of 5.3k |
| Message types in Go | 87. 22 pairing types dropped |
| Go estimate | 7k to 8k lines plus tests |

Web. 14 files import Next. Only `proxy.ts` is server side. Workspace packages export TS sources in `exports`, so Vite imports them with no transpile config. `sw.js` has no Next coupling beyond a comment. Monaco uses `loader.config({ monaco })` with local `monaco-editor`, so worker setup under Vite is the one real unknown.

Host. Go 1.27.1 present via linuxbrew. systemd user manager running, linger off. `net.ipv4.ip_unprivileged_port_start=1024`. tmux 3.7c, sockets `default` and `claude-probe`. Both Caddy volumes present. Merge base with upstream exists, so web cherry picks still work after relay goes.

Side note. `stt` container is unhealthy for 17 hours: "Cannot find module '/workspace/apps/stt/src/index.ts'". Needs restart before any dictation parity check.

## Changes to the plan

1. Order. Go first, Vite last. Go work is additive: new `apps/server`, Go toolchain in dev image. Vite migration breaks running dev web container and shared dependencies volume for its whole duration, and you drive agents through this UI daily. Go dev proxy is framework agnostic, so it fronts Next dev server today and Vite later with same code. Current stack stays alive as parity reference during Go work. Vite becomes short final step before embed. Phase 1 bridge (Caddy `file_server` or minimal web container for Vite build) is dropped, no throwaway work.
2. Port 443. User unit plus `loginctl enable-linger` plus sysctl drop-in `net.ipv4.ip_unprivileged_port_start=443`. One sudo for sysctl file. Binary updates need no sudo. User unit reaches user manager, so tmux server start via `systemd-run --user` is trivial. Plan's system unit with `User=` cannot reach user manager without env plumbing. Trade-off: any user process may bind 443 to 1023. Single user box, acceptable.
3. Go modules. Vendor them. Three small modules. `tools` container runs `network_mode: none`, so vendoring removes module cache volume and most helper changes. Release delay check happens once at vendor time. Review is a diff. Cost: about 10k lines in repo.
4. Scope. Drop from Go now: pairing routes and types, grants beyond one full grant, device approval, gate, `/_sessions`, clone creation. Keep: ownership check as plain authorization rule, clone name filter and sweep. "Policy completeness" test becomes "every client type has a handler".
5. Vite phase. Do not port `/start` and `/j` pages, server 302s them already. Deeper dead web code (census, machine switcher, `SealedTransport`, approval dialog) stays for cleanup phase.
6. React Router in library mode (`createBrowserRouter`), not framework SPA mode. Plain Vite config, no route module convention.
7. Spikes. Cut `go:embed` spike, trivial. Add backpressure spike: bounded send queue with `coder/websocket`, pty read loop blocks when full. Keep pty with UTF-8 carry, tmux start outside service cgroup, TLS leaf from test root, Monaco plus workspace packages under Vite.
8. Hub and node. One interface, two packages. Nothing more until a second machine exists.

## How we tackle it

Branch. Feature branch `go-single-binary`, commit per completed phase. Multi-session multi-agent work cannot sit uncommitted. Needs your OK, current rule is no commits unless asked.

Agents work in main checkout on disjoint paths. Worktrees do not fit: compose mounts main checkout and dependencies volume is shared and fingerprinted.

Per phase, me as coordinator:

- Phase 0. One workflow, four spike agents in parallel in Docker. Each returns findings and throwaway code. I record decisions in plan and backlog.
- Phase 2 and 3. Skeleton by one agent. Then fan out Go types, fixtures and tests by message group: auth and session, window and pane, terminal, file, repo, dictation and server. One agent adds Vitest fixture test.
- Phases 4 to 7. One agent per package in parallel, TS module as spec, tests ported with code: edge plus web plus ws lifecycle, tmux plus pty plus monitor, files plus repo, dictation. Then one integration agent wires router and runs against real tmux on isolated socket.
- Review gate after each phase. Code review on diff, findings fixed before next phase.
- Phase 9. Parity agent writes Playwright flows. Binary on spare loopback port, isolated tmux socket. Same flows on current stack.
- Vite migration after parity, one workflow: config and build, routing, Monaco and workers, env and headers. Browser check. Then embed and second parity pass, short.
- Phases 10 and 11 manual with you. CA copy, phone check, cutover. Never automated.

Decisions needed:

1. Commits on feature branch?
2. Order flip, Go first and Vite last?
3. Port 443 via user unit and sysctl?
4. Vendor Go modules?
5. Go ahead for phase 0 spikes.
