# Dictation

Talk, and text lands where the user is typing. Default target is the selected pane. A focused text field takes the text instead. Speech never leaves the host. English and Bulgarian.

## Boundary

Dictation is an optional deployment component. A stack without it behaves exactly as before.

- Service `stt` (`apps/stt`) in its own container under Compose profile `dictation`. Holds the models and runs inference. Only on internal network `speech`, shared with relay alone. No published port. Same hardening as relay plus `cpus: STT_THREADS` and `mem_limit: 3g`.
- Relay holds no model. Optional env `STT_URL` (Zod). Relay polls `stt` health (5 s while down, 30 s while up) and lists `dictation` in `auth:success.features` only while it answers. Web shows no mic otherwise.
- Browser never talks to `stt`. Audio rides the authenticated relay socket. Auth, origin checks and grant scopes stay in one place.
- One switch: `scripts/setup.sh --dictation` downloads models and writes `COMPOSE_PROFILES=dictation`, `STT_URL`, `LOCAL_STT_MODELS`, `STT_THREADS` to `.env`. Choice survives reruns. `--no-dictation` turns it off.

## Engine

- `sherpa-onnx-node` 1.13.8, prebuilt addon, no install scripts. Node runs `apps/stt` TypeScript directly with type stripping, no build step.
- `parakeet-tdt-0.6b-v3-int8`, HuggingFace `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` at `2bda32ec70b097a55adaa07d9a7173915b43cc78`.
- Silero VAD, HuggingFace `csukuangfj/vad` at `fba88cd2e921609e7675c3aaf51e0b9b295da4bc`, `silero_vad.onnx`.
- Every file checked by size and SHA-256 at setup. Stored under `~/.local/share/tmuxde/models`, mounted read-only at `/models`.
- One decode per utterance. Parakeet picks one language per decode, so a buffer holding an English and a Bulgarian sentence drops one of them. VAD cuts at pauses of 0.6 s, caps utterances at 25 s, and each piece gets 0.3 s of pre-roll because Silero marks speech late and clipped first sounds. Without the VAD file the service falls back to 30 s chunks cut at the quietest moment (Orca chunker, MIT).
- Decodes run one at a time through `decodeAsync`, so the event loop stays free.

## Protocol

Client to relay: `dictation:start { id }`, `dictation:audio { id, pcm }` (base64 PCM16 16 kHz mono, at most 64 KiB), `dictation:stop { id }`, `dictation:cancel { id }`.

Relay to client: `dictation:ready`, `dictation:text { text }` per utterance, `dictation:done`, `dictation:error { code, message }`.

Start and audio need write access. Stop and cancel only wind down this connection's own session. One session per connection, a second start replaces the first. Relay queues at most 1 MiB toward `stt`, ends sessions at 15 minutes, and cancels on socket close. `stt` stops taking audio at 10 minutes, closes idle sessions after 60 s and refuses more than 4 sessions with 1013.

Relay to `stt`: WebSocket `/v1/stream`, binary PCM16 frames and one `{"type":"stop"}`. Replies `ready`, `text`, `done`, `error`. Documented in `PROTOCOL.md`.

## Web

- Capture: `getUserMedia` mono with echo cancellation, noise suppression and gain control. `AudioContext` at device rate, `public/dictation-worklet.js` averages down to 16 kHz PCM16 and posts 200 ms frames and a level. Audio is held until `dictation:ready`.
- Target captured at start. A focused textarea or text input gets text at its caret through `setRangeText` and an `input` event. Otherwise the selected pane gets `terminal.paste(text)`, which uses bracketed paste when the app enabled it and never sends Enter. If session, pane or connection changes, or the pane enters copy mode, the rest goes to the composer. Control characters stripped, line breaks become spaces. Pieces joined with Orca's spacing rules.
- UI: mic in phone toolbar row 1 (grid grows to 7 columns), mic at bottom of desktop rail, `Ctrl+Shift+Space` everywhere (xterm passes it through). Buttons never take focus. Indicator above the terminal with level meter, elapsed time, Stop and discard.
- Connection loss, lock (disconnects), page hidden, mic unplugged or 10 minutes end the dictation. Hidden and unplugged stop and keep what was said.
- `Permissions-Policy: microphone=(self)` in `.docker/Caddyfile` and `apps/web/src/proxy.ts`.

## Out of scope

Live partial words inside an utterance, hold to talk, hotwords, Whisper as second engine, mic button inside the composer, browser speech API (sends audio to Google or Apple).
