# Speech service

Local speech to text for tmuxde dictation. Optional. It is the Go binary `tmuxde-stt`, built from `cmd/tmuxde-stt` and this package. It runs in its own `stt` container, and a stack without it works exactly as before, just without a mic button.

## Turn it on

From repository root:

```sh
scripts/setup.sh --dictation
docker compose up -d --build --wait
```

Setup downloads the models once, checks every file against its SHA-256 and writes these keys to root `.env`:

| Key | Value |
| --- | --- |
| `COMPOSE_PROFILES` | `dictation`, so Compose starts `stt` |
| `LOCAL_STT_MODELS` | `~/.local/share/tmuxde/models`, mounted read-only at `/models` |
| `STT_THREADS` | Half the CPU cores, at most 8 |

`LOCAL_STT_SOCKET_DIR`, the run directory, is written on every setup run, dictation on or off. Its `stt` subdir, mode 0750, is mounted at `/run/tmuxde/stt`. `scripts/setup.sh --host-service` writes `STT_SOCKET=<run dir>/stt/stt.sock` into the env file of the host service when dictation is on.

Later setup runs keep the choice. `scripts/setup.sh --no-dictation` turns it off and leaves the models on disk.

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

Both run on CPU through [sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 1.13.8. The service calls its C API through a small cgo binding in `sherpa/`, and the image ships the two prebuilt shared libraries of the release. No GPU needed.

## Speed and resources

Measured on 2x Xeon E5-2680 v3 (2014, AVX2) with FLEURS test speech:

| Threads | 30 s of speech | Words wrong, English | Words wrong, Bulgarian |
| --- | --- | --- | --- |
| 4 | 3.4 s | 8.4% | 12.9% |
| 8 | 2.3 s | 8.4% | 12.9% |
| 16 | 1.8 s | 8.4% | 12.9% |

A typical 10 s sentence turns into text in under a second. Most English errors are numbers written as words. Bulgarian keeps its meaning but sometimes splits or misspells a word.

The loaded model takes about 1.4 GB of memory and up to 1.7 GB while decoding. Compose limits the container to `STT_THREADS` CPUs and 3 GB. Startup takes about 7 s while the model loads. The tmuxde server offers the mic once its probe of the socket passes.

## Configuration

Environment variables, validated in `config.go`. Compose sets them.

| Variable | Default | Meaning |
| --- | --- | --- |
| `STT_MODEL_DIR` | required | Folder with `encoder.int8.onnx`, `decoder.int8.onnx`, `joiner.int8.onnx`, `tokens.txt` |
| `STT_VAD_MODEL` | unset | Path to `silero_vad.onnx`. Unset means 30 s chunks |
| `STT_SOCKET` | required | Unix socket to listen on. Absolute, at most 107 bytes. Compose sets `/run/tmuxde/stt/stt.sock` |
| `STT_THREADS` | `4` | Threads per decode |
| `STT_MAX_SESSIONS` | `4` | Dictations at once. More are refused as busy |
| `STT_MAX_SECONDS` | `600` | Audio per dictation before it stops by itself |

## Unix socket

The service listens only on the unix socket `STT_SOCKET`. There is no TCP listener. Compose sets `/run/tmuxde/stt/stt.sock`, which is `stt/stt.sock` in `LOCAL_STT_SOCKET_DIR` on the host. The host tmuxde server and the `server-dev` container dial it there. The container health check runs `tmuxde-stt health`, which sends `GET /health` over the same socket. At start a socket file left by a killed service is removed, but only if nothing answers on it.

## Limits

- One decode runs at a time. A second person dictating waits for the first decode to finish.
- A dictation stops by itself at 10 minutes of audio. A session that sends nothing for 60 s is closed.
- The tmuxde server ends any dictation after 15 minutes and gives up if more than 1 MiB of audio is waiting to be forwarded.
- Text appears per utterance, not word by word. Parakeet is not a streaming model.
- Switching language in the middle of a sentence, without a pause, can lose words in one of the languages. Pause briefly when you switch.

## Privacy and security

- The container has no network at all (`network_mode: none`) and no published port. Only the tmuxde servers reach it, over `stt.sock`. It can write only its own `stt` subdir of the run directory. Caddy has no group write on the socket.
- It has no authentication of its own. The tmuxde server has already checked the browser's token and origin before any audio arrives.
- The service never writes audio or text to disk, and neither does the tmuxde server. Logs hold one line per dictation with its length, decode time and outcome, never what was said.
- The container runs read-only, without Linux capabilities and as your host user.
- The browser only allows the microphone on this site (`Permissions-Policy: microphone=(self)`) and asks before the first recording.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No mic button | `docker compose ps stt` should say healthy. The server logs `Speech service availability changed` when it notices: `journalctl --user -u tmuxde` in production, `docker compose logs server-dev` on 18443. Reload the page: the browser learns about dictation when it connects. |
| "Microphone blocked" | Allow the microphone for the site in browser settings. The page must load over trusted HTTPS, see [Trust the local CA](../../.docker/README.md#trust-the-local-ca). |
| "Speech service is busy" | Four dictations are already running. |
| "No speech detected" | The level meter should move while you talk. If it does not, the browser is using the wrong microphone. |
| `stt` keeps restarting | `docker compose logs stt`. A missing model file names the setup command to run. |

## Development

```sh
docker compose logs -f stt                        # one JSON line per dictation
docker compose run --rm gotools go test ./internal/stt/... ./cmd/tmuxde-stt/...   # no model needed, uses a fake transcriber
docker compose up -d --build stt                  # rebuild the image after a change
```

Development and production both build `.docker/prod/stt.Dockerfile`. There is no hot reload: a rebuild restarts the service, which reloads the model in about 7 s. The image downloads the sherpa-onnx 1.13.8 release, checks its SHA-256 and compiles with `CGO_ENABLED=1 -tags sherpa`. Every other build, `go vet ./...` and `go test ./...` among them, gets `sherpa/stub.go` instead, never needs the C headers, and `tmuxde-stt serve` there exits with an error that names the build tag. x86_64 only for now.

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
