# Setup and operation

tmuxde has two parts on one machine:

- Production: the Go binary `tmuxde` runs on the host as the systemd user unit
  `tmuxde.service`. It serves the ui build embedded in the binary and drives
  the host tmux server. Caddy in Docker serves it on `https://<LOCAL_DOMAIN>`
  (port 443).
- Development: Docker Compose runs a dev copy of the server (`server-dev`) and
  the Vite dev server (`ui`). Caddy serves them on
  `https://<LOCAL_DOMAIN>:18443`. The dev copy has its own tmux server and
  never touches the host tmux or home.

Caddy owns TLS, the local CA, port 443 and the private network filter. The
binary never does TLS. It listens on a unix socket in the run directory.

```
Browser ─https/wss:443───► Caddy ─► run/http.sock ─────► tmuxde.service (host)
Browser ─https/wss:18443─► Caddy ─┬► run/dev/http-dev.sock ─► server-dev (Docker)
                                  └► ui:24100 ──────────────► Vite dev server (Docker)
tmuxde.service and server-dev ─► run/stt/stt.sock ─► stt (Docker, optional)
```

Requirements: Linux x86_64 with systemd, Python 3, Docker with Compose, tmux
3.2 or later and git on the host.

## Setup

From the repository root:

```sh
scripts/setup.sh                 # writes root .env, the token and the run directory
scripts/setup.sh --dictation     # the same, plus speech to text, see Dictation
```

Setup writes:

- `.docker/.env.token`, mode 0600. The sign in token, 64 hex characters.
  Kept on later runs.
- Root `.env`, mode 0600. Host user ids, the upload folder, the host home,
  `LOCAL_DOMAIN`, `LOCAL_BIND_IP`, the run directory `LOCAL_STT_SOCKET_DIR`
  and the dictation keys. Rerun setup instead of editing it. Keys that older
  setups wrote (`STT_URL`, `LOCAL_TMUX_DIR`, `LOCAL_TMUX_SOCKET`) are ignored
  and dropped on the next run.
- `~/.local/share/tmuxde/uploads`, mode 0700. Photo uploads land here.
- The run directory, by default `~/.local/state/tmuxde/run`, with its `dev`
  and `stt` subdirs. All mode 0750.
- Empty `node_modules` mount points for the dependency volume.

`LOCAL_BIND_IP` and `LOCAL_DOMAIN` default to `127.0.0.1` and `localhost`,
which only reach the host itself. For phones, set `LOCAL_BIND_IP` to the host
LAN address and `LOCAL_DOMAIN` to a name your internal DNS resolves to that
address on each device. Pass them once. Setup keeps them on later runs:

```sh
LOCAL_DOMAIN=tmux.home.arpa LOCAL_BIND_IP=192.168.1.10 scripts/setup.sh
```

Caddy accepts private network clients only. Port 80 stays free for other
services.

### Run directory

| Path | Written by | Mounted |
| --- | --- | --- |
| `http.sock` | `tmuxde.service` | Caddy, read only, whole directory |
| `dev/http-dev.sock` | `server-dev` | `server-dev` read write at `/run/tmuxde/dev` |
| `stt/stt.sock` | `stt` | `stt` read write and `server-dev` read only, at `/run/tmuxde/stt` |

Caddy runs as root without `DAC_OVERRIDE`. Compose adds the host user group,
so it can enter the 0750 directories. The HTTP sockets are created with umask
0002, so they are group writable and Caddy can connect. `stt.sock` has no
group write, so Caddy cannot reach it. `server-dev` never mounts the run
directory itself, so nothing in a dev pane can reach the production
`http.sock`.

## Trust the local CA

Caddy issues and renews certificates itself. No DNS token or public
certificate service is needed. Volume `tmuxde_caddy-data` holds the CA keys.
Keep it across rebuilds. Deleting it means trusting a new CA on every device.

Export the public root after Caddy has started:

```sh
mkdir -p .docker/certs
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .docker/certs/tmuxde-root.crt
```

Move `.docker/certs/tmuxde-root.crt` to the phone over a trusted channel, for
example AirDrop. On iPhone install the profile in Settings, then enable full
trust in Settings > General > About > Certificate Trust Settings. See
[Apple certificate trust instructions](https://support.apple.com/102390).
Other devices must trust the same root. Only the public root ever leaves
Caddy storage. Port 18443 uses the same CA, so nothing new is needed for it.

## Production

### Install

```sh
scripts/setup.sh
docker build -f .docker/prod/tmuxde.Dockerfile --target binary --output type=local,dest=.docker/bin .
scripts/setup.sh --host-service --print   # dry run, token masked, writes nothing
scripts/setup.sh --host-service
systemctl --user start tmuxde.service
curl --unix-socket ~/.local/state/tmuxde/run/http.sock http://localhost/health
docker compose up -d --wait caddy
loginctl enable-linger "$USER"
```

1. The build writes `.docker/bin/tmuxde`, a static binary with the ui build
   embedded.
2. `--host-service` installs it and writes the env file and the unit.
3. Start the unit. `journalctl --user -u tmuxde` shows `listening`.
4. The socket answers `{"status":"ok",...}`.
5. Compose starts Caddy with the run directory mounted read only.
6. Linger keeps the user manager, and tmuxde with it, running after logout
   and from boot. Setup prints this command and does not run it.

Then trust the CA, open `https://<LOCAL_DOMAIN>/login` and paste the token
from `.docker/.env.token`. A `#token=<token>` link signs in too.

`--host-service` reads root `.env` and the token, then writes:

- `~/.local/bin/tmuxde`, mode 0755. A replaced binary stays as
  `~/.local/bin/tmuxde.previous`. An unchanged binary is left alone.
- `~/.config/tmuxde/tmuxde.env`, mode 0600 in a 0700 directory:
  `AUTH_TOKEN`, `ALLOWED_PATHS` (upload folder, then home), `CORS_ORIGINS`,
  `TMUXDE_LISTEN=unix:<run>/http.sock`, `STT_SOCKET=<run>/stt/stt.sock` when
  dictation is on, `TMUXDE_CONFIG_DIR` and `HOME`. `TMUX_SOCKET` stays unset,
  so the binary uses the default tmux server, the one your shells use. To use
  another server, run setup with `TMUX_SOCKET=/path/to/socket` in the
  environment.
- `~/.config/systemd/user/tmuxde.service` from `.docker/host/tmuxde.service`.
  Its `PATH` starts with the directories of `tmux` and `git` as your shell
  finds them, since a user unit does not see Homebrew. The system
  directories of `/etc/environment` follow, sbin included. Panes of a tmux
  server that tmuxde starts inherit this `PATH`. `UMask=0002` makes
  `http.sock` group writable for Caddy.

Setup runs `systemctl --user daemon-reload` and `enable`. It does not start
the service. When the service runs, it says whether a restart is needed.

```sh
systemctl --user status tmuxde.service
journalctl --user -u tmuxde -f
```

### Update

```sh
docker build -f .docker/prod/tmuxde.Dockerfile --target binary --output type=local,dest=.docker/bin .
scripts/setup.sh --host-service
systemctl --user restart tmuxde.service
```

A restart ends browser connections. Browsers reconnect by themselves. tmux
sessions keep running.

### Rollback

The Node relay and the web container are gone. Rollback is the previous
binary:

```sh
systemctl --user stop tmuxde.service
cp ~/.local/bin/tmuxde.previous ~/.local/bin/tmuxde
systemctl --user start tmuxde.service
```

`loginctl disable-linger "$USER"` undoes linger.

### Uninstall

The first form stops and disables the service and removes the unit. It keeps
settings and binaries. `--purge` removes those too, except `access.log` in
`~/.config/tmuxde`.

```sh
scripts/setup.sh --host-service --uninstall
scripts/setup.sh --host-service --uninstall --purge
```

### tmux server and the unit

tmuxde starts a missing tmux server through `systemd-run --user --scope`, in
scope `tmuxde-tmux-<hex>.scope` outside the unit. Attach clients run with
`tmux -N` and never start a server. A server started from a shell is outside
the unit anyway. So stopping or restarting the unit leaves every session
alone. `KillMode` stays `control-group`.

`TMUXDE_TMUX_LAUNCHER` picks how the server starts. `auto`, the default, uses
systemd-run inside a unit and falls back to a plain start with a warning.
`systemd-run` fails instead of falling back. `none` makes the server a child
of tmuxde, so it dies with the unit. Setup rewrites the env file, so set it in
a drop-in with `systemctl --user edit tmuxde.service`.

The unit `PATH` must hold the tmux and git directories. Without them the
binary stops with `tmux is not installed or not found in PATH`. Rerun
`--host-service` after moving tmux or git.

### Caddy

Production Compose (`.docker/compose/prod.yaml`) runs only Caddy and the
optional `stt`:

```sh
docker compose -f .docker/compose/prod.yaml --env-file .env up -d --wait
```

On a machine that also develops, the development Compose file runs the same
Caddy with port 18443 added. Use one of the two, not both.

Caddy reads `.docker/Caddyfile` at start. The 443 site sends every request to
`http.sock`. Both sites reject non-private client addresses, redirect the old
code entry routes (`/start`, `/pair`, `/j`) to `/login` and set the CSP and
Permissions-Policy headers. The binary sets the other security headers. It
reads the client address from `X-Forwarded-For` only on its unix socket and on
loopback. Caddy replaces any `X-Forwarded-For` a client sends.

With `http.sock` mode 0755 Caddy logs `connect: permission denied` and
answers 502. Check `UMask=0002` in the unit.

Never run `docker compose down -v`. A plain `docker compose down` keeps the
volumes, but it also stops Caddy, so production on 443 goes offline until the
next `up`. Recreate Caddy alone with `docker compose up -d caddy`.

## Development

```sh
scripts/setup.sh
docker compose up -d --build --wait     # caddy, ui, server-dev, and stt with dictation
docker compose ps
docker compose logs -f server-dev
```

Open `https://<LOCAL_DOMAIN>:18443/login` and sign in with the same token.
The port is its own origin, with its own browser storage and login. Caddy
sends `/_relay`, `/file` and `/health` to `run/dev/http-dev.sock` and
everything else to `ui:24100`, the Vite dev server with HMR. The dev binary
serves no pages, so it logs `web build missing` at WARN level on start. On a
TCP listener the same line is an error.

### server-dev

`server-dev` runs air in the `gotools` image. air builds the Go module at the
repository root into `/tmp/tmuxde-dev/bin/tmuxde` and runs `tmuxde serve`. A
saved Go file rebuilds and restarts it in about two seconds. Tests,
`vendor/` and `testdata/` do not count. Settings are in `.air.toml`. air stops
the old binary with SIGINT, so it closes its WebSockets and removes its
socket. After a build error air keeps the last good binary. A binary that
exits on its own stays down until the next Go change and the health check
turns unhealthy. After `go-vendor` changed modules, restart `server-dev`.

The container has no network, no host tmux and no home mount:

- Its own tmux server on `/tmp/tmuxde-dev/tmux.sock` starts with the first
  session. Sessions start in `/tmp/tmuxde-dev`. They survive rebuilds of the
  binary and die with the container.
- `/repo` is this checkout, read only, for Files, Changes and History. It
  includes gitignored files such as `.env` and `.docker/.env.token`. Only a
  token holder on the private network sees them. Accepted for development.
- `/tmp/tmuxde-dev/scratch` is the writable scratch dir. `ALLOWED_PATHS`
  holds only `/repo` and the scratch dir.
- Run directory mounts: `dev` read write for `http-dev.sock`, `stt` read only
  for dictation. Never the run directory itself.

```sh
docker compose exec server-dev tmux -S /tmp/tmuxde-dev/tmux.sock ls
```

Production and development share only Caddy and `stt`. Port, socket, tmux
server, files and state are separate.

### ui

`ui` runs `vite --configLoader native` on port 24100 in the Node dev image.
Edits under `ui/src` update the page through HMR. It also publishes
`127.0.0.1:24100`, so a binary run by hand with
`TMUXDE_DEV_WEB_URL=http://127.0.0.1:24100` proxies pages and HMR there.

### Checks

All Node and Go tooling runs in Docker. Never install host `node_modules`.

```sh
docker compose run --rm tools pnpm typecheck
docker compose run --rm tools pnpm test
docker compose run --rm tools pnpm --filter @app/ui build
docker compose run --rm gotools go vet ./...
docker compose run --rm -e CGO_ENABLED=1 gotools go test -race ./...
docker compose config --quiet
docker compose -f .docker/compose/prod.yaml --env-file .env config --quiet
python3 -B .docker/dev/setup_test.py
python3 .docker/tests/runtime.py          # host ids, server-dev and stt isolation
```

### Dependencies

Node packages change only through the helper. It exports only validated
manifests and the lockfile, stops `ui` and `stt` while it writes the
dependency volume and starts them again afterwards:

```sh
python3 .docker/dev/dependencies.py mutate --filter @app/ui add <pkg>
python3 .docker/dev/dependencies.py       # resync after a manifest or image change
```

After a failed run the services stay stopped. Start them with
`docker compose up -d --no-build --wait ui stt`.

Go modules are vendored in `vendor/`. After a `go.mod` change run
`docker compose run --rm go-vendor`. It is the only networked Go service and
checks the five day release delay against `proxy.golang.org`.

Three volumes hold dependencies, caches and the pnpm store. Releases younger
than five days are refused, without exclusions. Approved native builds run
offline.

## Dictation

Talk, and the words appear where you type. Speech to text runs on this
machine in the `stt` container. Audio never leaves the host.

```sh
scripts/setup.sh --dictation
docker compose up -d --build --wait
scripts/setup.sh --host-service          # adds STT_SOCKET for production
systemctl --user restart tmuxde.service
```

Setup downloads two models once into `~/.local/share/tmuxde/models`, about
670 MB, from pinned HuggingFace revisions checked by SHA-256. Parakeet TDT
0.6B v3 transcribes 25 European languages. Silero VAD finds the pauses
between utterances. Setup writes `COMPOSE_PROFILES=dictation`,
`LOCAL_STT_MODELS` and `STT_THREADS` to `.env` and keeps the choice on later
runs. `scripts/setup.sh --no-dictation` turns it off and keeps the models.

`stt` listens only on `run/stt/stt.sock`. It has no network at all and no
published port. Its health check uses the socket too. Production and
`server-dev` both dial it, and offer the mic only while their probe passes.
`journalctl --user -u tmuxde` and `docker compose logs server-dev` show
`dictation configured` with the socket path and
`Speech service availability changed`.

Press the mic in the phone toolbar or desktop sidebar, or Ctrl+Shift+Space.
The browser asks for microphone permission once. A focused text field gets
the words at its caret. Otherwise they are pasted into the selected pane
without Enter. Text appears after each pause. Stop keeps what was said, the
cross discards it. Locking the device, switching app or losing the
connection ends dictation. Details and measurements are in
[stt/README.md](../stt/README.md).

## Using it

- The browser drives live host sessions. It can reach every session on that
  tmux server.
- Files opens the directory of the selected pane. Changes shows staged,
  unstaged and untracked files with inline diffs. History pages commits.
  There are no Git write actions. The host home is readable, credential
  directories stay blocked, and repositories outside `ALLOWED_PATHS` are
  refused.
- Photo uploads go to the upload folder, at most 10 MB. The path is pasted
  into the prompt without Enter. If the pane changed meanwhile, the path is
  shown instead.
- On phones the keyboard button types into the terminal. Draft opens an
  editor, More holds Ctrl, Alt, arrows and tmux actions. Navigation mode gives
  arrows, Esc and Enter without the keyboard.
- Fonts, syntax highlighting and the editor are bundled. Nothing is fetched
  from a CDN.

## Privacy

No telemetry, analytics, accounts, update checks or hosted services. Framework
telemetry stays off in development, builds and runtime. Builds download
images and packages. Commands you run in tmux keep the host network. The
token, root `.env` and built binaries stay outside Git and the Docker build
context.

## Toolchain pins

Newest stable versions that satisfied the five day dependency policy when
checked. Docker images and package manifests pin them.

| Tool | Version |
| :--- | :--- |
| Go (checked 2026-10-12) | 1.27.2 |
| air (checked 2026-10-12) | 1.67.4 |
| Node.js | 26.11.1 |
| npm bootstrap | 12.2.0 |
| pnpm | 12.11.2 |
| Vite | 8.3.3 |
| React Router | 8.4.0 |
| React | 19.3.0 |
| TypeScript compiler | 7.0.2 |
| Vitest | 5.0.3 |
| Tailwind CSS | 4.3.3 |

There is no linter or formatter. Planned replacement is oxlint and oxfmt.
