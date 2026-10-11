# Dictation backlog

Plan: [../dictation.md](../dictation.md)

## Progress summary

| Phase | Status |
| --- | --- |
| 0. Engine benchmark | [x] |
| 1. `stt` service, model setup, Compose profile | [x] |
| 2. Protocol and relay forwarding | [x] |
| 3. Web capture, insertion and UI | [x] |
| 4. Verification | [~] |

## How to resume

Read the plan. Work is on branch `feat/dictation`. Run `docker compose run --rm tools pnpm test` and `pnpm typecheck`. Dictation needs `scripts/setup.sh --dictation` once, then `docker compose up -d --build --wait`; `docker compose logs stt` shows `"segments":"utterances"` when the VAD loaded. Remaining work is the phone check below.

## Phase 0. Engine benchmark

- [x] FLEURS test clips, 30 per language: `en_us` 289 s, `bg_bg` 317 s
- [x] Parakeet TDT 0.6B v3 int8, sherpa-onnx 1.13.8, greedy, 2/4/8/16 threads
- [x] Whisper large-v3-turbo, faster-whisper 1.2.1 int8, greedy, 8/16 threads
- [x] Engine: Parakeet. User skipped own voice test on 2026-10-11.

Host: 2x Xeon E5-2680 v3 (Haswell, AVX2, no AVX-512), no GPU.

| Engine | Threads | RTF | 30 s audio | WER en | WER bg | CER en | CER bg | Load | Peak RSS |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Parakeet v3 | 2 | 0.17 | 5.3 s | 8.4% | 12.9% | 4.7% | 3.7% | 4 s | 1.25 GB |
| Parakeet v3 | 4 | 0.11 | 3.4 s | same | same | same | same | 4 s | 1.25 GB |
| Parakeet v3 | 8 | 0.07 | 2.3 s | same | same | same | same | 4 s | 1.25 GB |
| Parakeet v3 | 16 | 0.06 | 1.8 s | same | same | same | same | 4 s | 1.25 GB |
| Whisper turbo | 8 | 0.80 | 16.5 s | 5.5% | 9.3% | 2.8% | 2.5% | 5 s | 2.4 GB |
| Whisper turbo | 16 | 0.59 | 12.3 s | same | same | same | same | 5 s | 2.1 GB |

Notes:

- Parakeet English errors are mostly numbers spoken as words ("twenty five" for "25") and punctuation.
- Parakeet Bulgarian splits or misspells some words ("Санкт Петър бъд", "с мес"). Meaning survives, CER 3.7%.
- Whisper pads every input to 30 s, so a 5 s phrase costs nearly as much as 30 s. Too slow to wait on with this CPU.
- 8 threads is the knee for Parakeet.

## Phase 1. `stt` service, model setup, Compose profile

- [x] Node workspace `apps/stt` with `sherpa-onnx-node` 1.13.8, `ws`, `zod`. Passed lockfile policy. Type stripping, no build
- [x] Workspace wiring: `workspace.yaml` mounts, `init-volumes.sh`, root `vitest.config.ts`
- [x] Service: `/health`, `/v1/stream`, PCM16 in, text per utterance out, session, idle and length limits
- [x] Segmenter: Silero VAD per utterance with 0.3 s pre-roll, 30 s chunker fallback
- [x] Setup `--dictation` / `--no-dictation`: pinned downloads, SHA-256, models root, `.env` keys, choice kept on rerun
- [x] Setup creates empty `node_modules` mountpoints for every workspace. Read-only `apps` bind cannot create them, which broke fresh clones and the new workspace
- [x] Compose profile `dictation` in dev and prod, network `speech`, hardening, `cpus`, `mem_limit: 3g`
- [x] `.docker/prod/stt.Dockerfile`, 399 MB, verified read-only, no capabilities, healthy
- [x] Tests: server, session, chunker, PCM, history ring (22)

## Phase 2. Protocol and relay forwarding

- [x] `dictation:*` schemas, codec tests, `PROTOCOL.md` incl. internal service protocol
- [x] `STT_URL` in relay `config.ts`, health probe, `dictation` feature
- [x] `dictation.ts` forwarding, early audio queue, backpressure, session timer, cancel on close
- [x] `message-router.ts` cases, `policy.ts` entries, `ConnectionState.dictation`
- [x] Tests against fake service (15)

## Phase 3. Web capture, insertion and UI

- [x] `microphone=(self)` in Caddyfile and `proxy.ts`
- [x] `public/dictation-worklet.js` downsampler, `lib/dictation-audio.ts` capture
- [x] `lib/dictation-text.ts` sanitize, spacing, field insertion
- [x] `lib/dictation.ts` controller, `stores/dictation-store.ts`
- [x] `use-websocket.ts` handlers, `ws-client.ts` drop list
- [x] Toolbar mic, rail mic, indicator, `Ctrl+Shift+Space`, xterm passthrough, shortcuts dialog
- [x] Tests: text, worklet, hotkey, controller (30)

## Phase 4. Verification

- [x] Tests (1274 at time of writing), typecheck, build
- [x] Service end to end with real model, dev and prod images
- [x] Relay end to end through Caddy with relay token, mixed English and Bulgarian
- [x] Browser check: headless Chrome 124 with fake mic, isolated tmux session, desktop rail and hotkey, phone toolbar layout, no console errors
- [x] Stack without profile: Compose lists no `stt` (dev and prod), relay `STT_URL` empty, probe off, no `dictation` feature (unit tested)
- [x] Review: `.agents/reviews/dictation-pr-review.md`, three findings fixed
- [ ] Phone check on device: iOS Safari and Android Chrome, mic permission prompt, keyboard stays up

## Session notes

### 2026-10-11

- Studied Orca dictation (`.external/orca/src/main/speech`): sherpa-onnx in a worker, Parakeet v3 default, 30 s pause chunker, text inserted with `terminal.paste`. Phone only records and sends audio.
- User decisions: local only, optional deployment component, English and Bulgarian, benchmark first, then "no more tests, implement Parakeet".
- Phase 0 benchmark on FLEURS. Parakeet v3 is 8 to 10 times faster than Whisper turbo with somewhat worse Bulgarian.
- Phases 1 to 3 built. `dependencies.py mutate install` needs `--no-frozen-lockfile` because tooling sets `CI=true`. A failed first run left dev web and relay stopped for about three minutes; the helper resumes only services that were running when it started.
- End to end found two model problems, both fixed in the service. A decode holding both languages dropped one, so the service now decodes per utterance with Silero VAD. The VAD clipped first sounds ("Сплавите" to "Плавете"), so each utterance gets 0.3 s pre-roll.
- FLEURS clips are float32 WAV and some are very quiet. Test clients converted to PCM16 and levelled them the way browser gain control would.
- Docs: root `README.md` section "Talk to your terminal", component guide `apps/stt/README.md`, setup section in `.docker/README.md`.
- Open: on-device phone check. Composer has no mic of its own: it is a modal, so toolbar and rail are unreachable while it is open.
- Review before PR, saved to `.agents/reviews/dictation-pr-review.md`. Fixed: phone indicator now sits outside the terminal tab, so a live mic shows on every tab. Relay waits for stt health (`depends_on`, `required: false`) so browsers reconnecting during model load still get the mic. `.external` kept out of Docker build context.
