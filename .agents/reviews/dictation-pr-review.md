# Review: dictation and pending working tree changes

Date: 2026-10-11. Scope: everything uncommitted on `main` after `dd6c8f9`. That is optional local dictation (`apps/stt`, relay `dictation.ts`, protocol, web capture and UI, Compose profile, setup), plus three unrelated fixes: tmux scroll flick through `send-keys -N`, copy mode re-check on pane switch and attach, and a terminal gutter.

Checks: `pnpm test` 84 files, 1274 tests pass. `pnpm typecheck` clean in every workspace. The new tmux test `sends a long flick as one repeated event` runs against real tmux 3.7c and passes (not skipped). Protocol counts in `PROTOCOL.md` (56 client, 33 server) match the unions.

Project rules hold: schemas, both handlers, codec tests, `PROTOCOL.md` and `policy.ts` entries exist for all eight `dictation:*` types. New workspace has `workspace.yaml` mounts, `init-volumes.sh` entry and root `vitest.config.ts` project. Start and audio need write grant. Transcripts are not logged by stt or relay. Text is stripped of C0 and C1 controls and newlines before paste, so no ESC or Enter reaches the pty.

## Findings

### 1. Phone: live mic has no indicator off the terminal tab (fixed)

`apps/web/src/components/terminal/terminal-workspace.tsx`, mobile branch of `TerminalWorkspace`. `<DictationIndicator />` sat inside the terminal tab box, which gets `invisible absolute inset-0 pointer-events-none` when `mobileTab !== "terminal"`. The toolbar mic also disappears there: `app/(terminal)/layout.tsx:345` renders `KeyboardToolbar` only on the terminal tab. Start dictation, tap Sessions, Files or Settings, and the microphone keeps recording with nothing on screen to show or stop it. Desktop already placed the indicator outside the terminal box for this reason.

Fix applied: indicator moved to the outer mobile container, after the tab boxes, with same positioning. Web typecheck passes.

### 2. Mic missing after stack restart until next reconnect (fixed)

`apps/relay/src/wire-connections.ts:276` adds `dictation` to `auth:success.features` from `dictationAvailable()` at auth time only. Nothing updates features later. Relay does not wait for stt: no `depends_on`. stt needs 6.8 s to load the model (`docker compose logs stt`, `"Model loaded" ... "ms":6828`) and the probe polls every 5 s while down. Browsers that reconnect in that window after `docker compose up` or a host reboot get no mic button and no hotkey until they reconnect again.

Fix applied: relay `depends_on: { stt: { condition: service_healthy, required: false } }` in `.docker/compose/dev.yaml` and `.docker/compose/prod.yaml`. Verified with `docker compose config` for dev and prod under both `COMPOSE_PROFILES=` and `COMPOSE_PROFILES=dictation`, and `docker compose --dry-run up -d` with the profile off starts relay without stt. Cost: relay starts about 10 s later when dictation is on. A stt restart alone still leaves connected browsers stale. That case answers `UNAVAILABLE` on start, which is acceptable.

### 3. `.external/` sent as Docker build context (fixed)

`.gitignore` gained `.external/` (451 MB Orca checkout) but `.dockerignore` did not. All three prod Dockerfiles build with context `../..`, and `stt.Dockerfile` copies the whole context in its `manifests` stage. Every prod build uploaded and copied 451 MB for nothing.

Fix applied: `.external` added to `.dockerignore`. `.gitignore` entry moved under its own comment instead of inside the dependencies block.

## Notes, no change needed

- Composer has no mic of its own. It is a modal, so toolbar and rail are unreachable while it is open. Desktop hotkey works there. Already tracked as open in `dictation-backlog.md`.
- Phone check on real iOS Safari and Android Chrome is still open in the backlog. Unit tests and headless Chrome cannot cover the permission prompt or keyboard staying up.
- Working tree mixes dictation with three unrelated fixes. PR keeps them as separate commits.
