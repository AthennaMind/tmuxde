# Remove session recording

Created 2026-10-10. Companion backlog: [backlogs/remove-recordings-backlog.md](backlogs/remove-recordings-backlog.md).

## Goal

Delete session recording and playback end to end. No `.cast` capture, storage, listing, download, sharing or player remains in protocol, relay, web, workspace, Docker or docs.

## Surface

- `packages/cast`: codecs, writer, timeline. Whole package goes.
- `packages/protocol`: `recordings.ts`, five `recording:*` client messages, five server messages, `recordings` arm of `GrantScope`.
- `apps/relay`: `recorder.ts`, `recordings-index.ts`, router handlers and chunk streaming, policy allow-list and `recordingTarget`, grant helpers, `GET /recording`, startup sweep, shutdown stop, recording tmux clone, `recording` feature flag, `recordings` connection scope.
- `apps/web`: `/r` and `/r/[recordingId]` routes, `components/recording/*`, `recording-store`, `cast-fetch`, `player-clock`, toolbar record button, websocket handlers, recordings-scope redirect, feature helpers.
- Infra: Caddy `/recording` route, `packages/cast` dependency mounts, root Vitest project entry, lockfile.
- Docs: `AGENTS.md` map, archived `recording.mdx` and recording sections in `cli`, `security`, `sharing`, `web-app` pages.

## Keep

- Replay-attack protection in `packages/crypto`, transport and pairing. Same word, different feature.
- Scrollback replay on attach in `tmux-manager.ts`.
- `xterm-factory.ts`. Terminal view still uses it.
- Orphan clone sweep. It already covers any leftover recording clones by prefix.

## Notes

- Grants are not read from disk in this fork. Only `FULL_GRANT` and pairing tokens exist, so dropping the `recordings` scope arm breaks no stored data.
- Dev relay keeps state in `/tmp/mtmux-state`. No recordings persist in this deployment.
