# Speech service

Local speech to text for tmuxde dictation. Optional. It is the Go binary `tmuxde-stt`, built from `cmd/tmuxde-stt` and this package. It runs in its own `stt` container, and a stack without it works exactly as before, just without a mic button.

## Run

Development starts speech service with UI and Go server:

```sh
make setup
docker compose up -d --build --renew-anon-volumes --wait
docker compose logs -f stt
```

Linux amd64 and arm64 releases include static `tmuxde-stt` executable with
Parakeet and Silero models embedded. No shared libraries or model downloads are
needed at runtime. Start downloaded binary with:

```sh
STT_SOCKET=/tmp/tmuxde-stt.sock ./tmuxde-stt serve
```

First start extracts models into `$XDG_CACHE_HOME/tmuxde-stt`, defaulting to
user cache directory. Cache needs about 642 MiB of writable disk space.
Each file is checksum verified; corrupt files are repaired on next start.
Model embedding and extraction live under `cmd/tmuxde-stt/internal/bundle`,
owned by command rather than shared speech package.

Container `ghcr.io/athennamind/tmuxde-stt:<tag>` contains same bundled binary on
Google distroless static base. It runs as UID/GID 65532, defaults to socket
`/tmp/stt.sock`, and needs writable cache and socket directories. Share socket
with tmuxde server and set matching `STT_SOCKET`. Run with no network.
Local production uses native services. Machine-specific settings live outside checkout.

## How it works

```
mic ─► browser worklet ─► tmuxde ─► stt ─► text ─► tmuxde ─► focused field or pane
       16 kHz PCM16       (auth)   VAD + Parakeet
```

1. The browser records the microphone and downsamples it to 16 kHz mono PCM16 in an AudioWorklet (`src/ui/public/dictation-worklet.js`). It sends 200 ms frames over the `/_relay` WebSocket it is already logged in to.
2. The tmuxde server checks token, origin and write access, then forwards the audio to this service. One WebSocket per dictation.
3. Silero VAD cuts the audio into utterances at pauses of 0.6 s. Each utterance gets 0.3 s of audio from before it, because the VAD marks speech slightly late and would clip a soft first sound.
4. Parakeet decodes each utterance as soon as it ends and sends the text back. The browser types it in while you keep talking.
5. On Stop, the last utterance is decoded, then the session ends.

Decoding one utterance at a time is what makes language switching work. Parakeet settles on one language per decode, so a buffer holding an English sentence and a Bulgarian one comes back with one of them missing. It also means silence is never decoded, so the model has nothing to invent words from.

Without the VAD model, the service falls back to chunks of up to 30 s, cut at the quietest moment near the end.

## Models

| Model | Purpose | Source | Size |
| --- | --- | --- | --- |
| Parakeet TDT 0.6B v3, int8 | Speech to text, 25 European languages | [`csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8`](https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8) at `2bda32ec` | 670 MB |
| Silero VAD | Finds pauses between utterances | [`csukuangfj/vad`](https://huggingface.co/csukuangfj/vad) at `fba88cd2` | 1.8 MB |

Both run on CPU through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 1.13.8. The service calls its C API through a small cgo binding in `sherpa/`, and releases link engine libraries statically. No GPU needed.

## Speed and resources

Measured on 2x Xeon E5-2680 v3 (2014, AVX2) with FLEURS test speech:

| Threads | 30 s of speech | Words wrong, English | Words wrong, Bulgarian |
| --- | --- | --- | --- |
| 4 | 3.4 s | 8.4% | 12.9% |
| 8 | 2.3 s | 8.4% | 12.9% |
| 16 | 1.8 s | 8.4% | 12.9% |

A typical 10 s sentence turns into text in under a second. Most English errors are numbers written as words. Bulgarian keeps its meaning but sometimes splits or misspells a word.

The loaded model takes about 1.4 GB of memory and up to 1.7 GB while decoding. Default development service uses four decode threads. Startup takes about 7 s while the model loads. The tmuxde server offers the mic once its probe of the socket passes.

## Configuration

Environment variables, validated in `config.go`. Compose sets them.

| Variable | Default | Meaning |
| --- | --- | --- |
| `STT_MODEL_DIR` | bundled in releases | Folder with `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt` |
| `STT_VAD_MODEL` | bundled in releases | Path to `silero_vad.onnx`. Set empty to use 30 s chunks |
| `STT_SOCKET` | required | Unix socket to listen on. Absolute, at most 107 bytes. Dev Compose sets `/run/stt/stt.sock` |
| `STT_THREADS` | `4` | Threads per decode |
| `STT_MAX_SESSIONS` | `4` | Dictations at once. More are refused as busy |
| `STT_MAX_SECONDS` | `600` | Audio per dictation before it stops by itself |

## Unix socket

Service listens only on Unix socket `STT_SOCKET`, without TCP listener.
Dev server and STT share `stt-socket` volume at `/run/stt`. Health command sends
`GET /health` over same socket. Startup removes stale socket only if no service
answers. Production may use separate host socket directory.

## Limits

- One decode runs at a time. A second person dictating waits for the first decode to finish.
- A dictation stops by itself at 10 minutes of audio. A session that sends nothing for 60 s is closed.
- The tmuxde server ends any dictation after 15 minutes and gives up if more than 1 MiB of audio is waiting to be forwarded.
- Text appears per utterance, not word by word. Parakeet is not a streaming model.
- Switching language in the middle of a sentence, without a pause, can lose words in one of the languages. Pause briefly when you switch.

## Privacy and security

- Dev service has no network (`network_mode: none`) and no published port. Go server reaches it over `stt.sock`. Checkout is mounted read/write for hot reload.
- It has no authentication of its own. The tmuxde server has already checked the browser's token and origin before any audio arrives.
- The service never writes audio or text to disk, and neither does the tmuxde server. Logs hold one line per dictation with its length, decode time and outcome, never what was said.
- The container runs read-only, without Linux capabilities and as your host user.
- The browser only allows the microphone on this site (`Permissions-Policy: microphone=(self)`) and asks before the first recording.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No mic button | `docker compose ps stt` should say healthy. The server logs `Speech service availability changed` when it notices: `journalctl --user -u tmuxde`. Reload the page: the browser learns about dictation when it connects. |
| "Microphone blocked" | Allow the microphone for the site in browser settings. The page must load over trusted HTTPS, see [development guide](../../docs/DEVELOPMENT.md). |
| "Speech service is busy" | Four dictations are already running. |
| "No speech detected" | The level meter should move while you talk. If it does not, the browser is using the wrong microphone. |
| `stt` keeps restarting | `docker compose logs stt`. A missing model file names the setup command to run. |

## Development

```sh
make go-test GO_TEST_ARGS='./internal/stt/... ./cmd/tmuxde-stt/...'
```

Native release commands live directly in `.github/workflows/release.yml`.
Asset URLs and checksums live in `cmd/tmuxde-stt/assets.json`.
Default Go tests use fake transcriber and need no models or C headers.
Development Air builds with `sherpa` tag and loads models from `/opt/stt/models`
in dev image. Production `tmuxde-stt` target in root `Dockerfile` builds standalone binary
from source, downloading verified libraries and embedding models. Docker
release jobs use same source build. GoReleaser publishes native binary archives.
Changes under command or speech package rebuild service and reload model.
Releases add `stt_bundle`, `netgo` and `osusergo` tags for standalone static binary.
CI uses visible native commands and official GoReleaser action.
See [development guide](../../docs/DEVELOPMENT.md) for container check commands and
[component notices](../../docs/stt-notices.md) for model attribution.

| File | Role |
| --- | --- |
| `cmd/tmuxde-stt/main.go` | `serve` loads models and listens on the unix socket. `health` and `version` |
| `server.go` | `GET /health` and WebSocket `/v1/stream`, session cap |
| `session.go` | One dictation: audio in, text out, limits |
| `segmenter.go` | Silero VAD per utterance, or 30 s chunks |
| `pcm.go` | 16-bit PCM to float samples, odd byte counts refused |
| `chunker.go` | Cuts at the quietest moment near 30 s (adapted from Orca, MIT) |
| `transcriber.go` | Model file check and one decode at a time |
| `socket.go` | Listens on the socket, removes a stale one |
| `config.go` | Environment variables |
| `sherpa/` | cgo binding to Parakeet and Silero through the sherpa-onnx C API |

The protocol is in [PROTOCOL.md](../../src/ui/src/protocol/PROTOCOL.md), under "Dictation" for browser messages and "Speech service (internal)" for this service.
