# Local Docker stack

Run web client and relay against existing host tmux sessions. Requires Linux
x86_64 with glibc, Python 3, tmux, and Docker Compose. Start tmux before setup.

From repository root:

```bash
scripts/setup.sh
docker compose up -d --build
cat .docker/.env.token
```

Trust local CA using steps below, then open `https://<LOCAL_DOMAIN>/login`,
paste token, and select session.
Fresh browsers opening site root also reach token login. Caddy redirects code
entry routes to `/login` because standalone relay does not issue pairing codes.
Browser controls live host sessions. Socket access includes all sessions on that
tmux server. Host home is mounted read-only at its original path for repository browsing.
Shared upload folder remains writable through its separate mount.

Terminal bundles Symbols Nerd Font Mono for prompt icons. Font loads from this
server, including on iPhone. Saved text font preferences still apply to text.
Default text uses bundled IBM Plex Mono. Mobile uses medium weight, increased
line spacing, and minimum contrast for readability.

On phones, tap keyboard button to type directly into terminal. Enter sends
terminal Return. Ctrl and Alt apply to next key. Draft opens optional editor;
Enter inserts a newline there, and Send submits draft. More opens extra controls.
With software keyboard open, controls collapse to one row. Photo stays visible.
More reveals Ctrl, arrows, Alt, Draft, and remaining actions. Top window tabs hide
while software keyboard is open. Tmux actions live under More instead of covering
terminal prompt. More > Navigation mode provides arrows, Esc, and Enter without
opening keyboard. Hold an arrow to repeat; release stops it. At narrow widths,
swipe control row sideways to reach Esc and Enter. Keyboard button restores typing
mode. Dim terminal text uses stronger opacity on mobile while preserving colors.

Photo uploads work from mobile first row and desktop header. Pick an image
from Photos, camera, or Files. After upload finishes, its absolute path is pasted
into current terminal prompt without pressing Enter or opening keyboard. Add
your question and submit it yourself. If session or pane changes during upload,
photo stays saved and path is shown instead of being pasted into another pane.
Photo button shows last upload thumbnail. More > Recent photos on mobile, or
Recent photos in desktop header, previews and reuses last eight uploads without
uploading again. Recent list lasts for current browser connection; saved files
remain after refresh. Reuse checks file availability before inserting path.

Setup creates `~/.local/share/tmuxde/uploads` with private directory permissions.
`LOCAL_UPLOAD_DIR` in generated Compose environment mounts this directory at
identical host and relay paths. This folder stays first in file allow-list so Photo keeps using it.
Host home is also readable. Credential directories remain blocked.
Uploads survive container rebuilds and remain until you delete them using Files
or host filesystem. Maximum photo size is 10 MB. PNG, JPEG, WebP, and GIF retain
original bytes. Other image formats are converted to JPEG when browser can
decode them; otherwise picker reports an error. Transfer uses local authenticated
connection. Submitting image to Codex or Claude uses that agent's normal service.

Files opens current pane directory each time. Browse folders and read source files
with line numbers. Changes shows current Git changes grouped as staged, unstaged,
and untracked. Select a file for its inline diff. No branch comparisons or Git
write actions are included. Desktop uses Files button in terminal toolbar.

Source previews and diff lines use bundled syntax highlighting. Unknown languages
and large previews keep plain text. Changes has List and Tree layouts. Tree groups
files into collapsible folders within each change group. Browser saves layout
preference locally. Highlighting needs no external service or CDN.

Within Files, swipe right to go back and left to go forward through folders and
previews. Header arrows provide the same navigation on desktop. Safari browser
history also restores viewer pages before returning to earlier app tabs. Wide
code and breadcrumbs keep native horizontal scrolling; use header swipes or
arrows there. Explicitly reopening Files starts from current pane directory.

`LOCAL_HOST_HOME` is generated from host home directory. It is mounted read-only
at the same absolute path, so tmux pane paths also resolve inside relay container.
Repositories outside this directory need an additional read-only bind and an
entry in `ALLOWED_PATHS`. Git is bundled in relay image. File viewing and diffs
run locally without network access. Relay state uses `/tmp/tmuxde-state`; host
`~/.tmuxde` stays blocked even with this separate state directory.

Caddy binds TCP port 443 on `LOCAL_BIND_IP` and accepts private network
clients. Defaults are `127.0.0.1` and `localhost`, which only reach the host
itself. For phones, set `LOCAL_BIND_IP` to the host LAN address and
`LOCAL_DOMAIN` to a name your internal DNS resolves to that address on each
device. Put both in root `.env`, or pass them to setup once:

```sh
LOCAL_DOMAIN=tmux.home.arpa LOCAL_BIND_IP=192.168.1.10 scripts/setup.sh
```

Setup keeps both values when it rewrites `.env`. Relay uses same HTTPS origin
through `/_relay`. Web and relay
ports are not published. Port 80 remains available to existing services.

## Dictation (optional)

Talk, and the words appear where you type. Speech to text runs on this
machine in a separate `stt` container. Audio never leaves the host.

```sh
scripts/setup.sh --dictation
docker compose up -d --build --wait
```

Setup downloads two models once into `~/.local/share/tmuxde/models`, about
670 MB: Parakeet TDT 0.6B v3 transcribes 25 European languages, English and
Bulgarian included. Silero VAD finds the pauses between utterances. Files come
from pinned HuggingFace revisions and are checked by SHA-256. Setup writes
`COMPOSE_PROFILES=dictation`, `STT_URL`, `LOCAL_STT_MODELS` and `STT_THREADS`
to `.env` and keeps the choice on later runs. `scripts/setup.sh --no-dictation`
turns it off and keeps the models.

Press the mic in the phone toolbar or desktop sidebar, or Ctrl+Shift+Space.
The browser asks for microphone permission once. A focused text field gets the
words at its caret. Otherwise they are pasted into the selected pane without
Enter, so you can read them before sending. Text appears after each pause
while you keep talking. Stop keeps what was said; the cross discards it. If the
pane changes during dictation, the rest goes to Draft instead. Locking the
device, switching app or losing the connection ends dictation.

Language is detected per utterance. Pause briefly when switching between
English and Bulgarian. A sentence that mixes both may lose words in the less
dominant language.

`stt` gets `STT_THREADS` CPUs (half the cores, at most 8) and 3 GB memory. The
loaded model uses about 1.4 GB. On 8 Haswell cores 30 s of speech decodes in
about 2.3 s. It has no internet route and no published port. Only relay
reaches it, over internal network `speech`, after checking token, origin and
write access. Audio and transcripts are neither stored nor logged. Without the
profile there is no `stt` container, relay `STT_URL` stays empty and no mic is
shown. Production Compose uses same profile and builds
`.docker/prod/stt.Dockerfile`.

## Trust local CA

Caddy issues and renews certificates locally. No DNS token or public certificate
service is needed. Persistent `caddy-data` volume holds CA keys and certificates.
Keep this volume across rebuilds. Deleting it requires trusting a new CA on each
device.

Export public root certificate from repository root after stack starts:

```bash
mkdir -p .docker/certs
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .docker/certs/tmuxde-root.crt
```

Transfer `.docker/certs/tmuxde-root.crt` to iPhone, for example through AirDrop from Mac.
Install downloaded certificate profile through Settings, then open
Settings > General > About > Certificate Trust Settings and enable full trust
for tmuxde local CA. Safari will then trust this site's HTTPS certificate.
Use trusted file transfer for first installation because site certificate is
not trusted yet. Only public root certificate should leave Caddy storage.

See [Apple certificate trust instructions](https://support.apple.com/102390).
Other client devices must also trust this root certificate.

## Host setup and privacy

Setup copies host tmux client and shared libraries to avoid client/server
version mismatch. UTF-8 locale preserves tmux metadata delimiters. Token,
generated environment, and host binaries stay outside Git and Docker build
context. Setup preserves existing token on repeat runs.

For custom socket, run setup with `TMUX_SOCKET=/path/to/socket` in environment.
Run setup again after changing host tmux version or socket. Restart stack with
`docker compose up -d --force-recreate` from repository root afterward.

Web and relay use internal Docker network with no internet route. Caddy publishes
HTTPS on internal network address. Browser connection policy permits this origin
only. Microphone access is allowed for this origin only, and only dictation
uses it. Next.js telemetry is disabled in development, builds and runtime.
Hosted authentication and its telemetry dependency have been removed. No broker, account service, or CLI heartbeat runs in this stack.
Builds still download images and package dependencies. Fonts are bundled locally. Commands running inside host
tmux retain host network access.

From repository root:

```bash
docker compose logs -f
docker compose down
docker compose up -d
```

Stopping stack leaves host tmux sessions running. Source changes reload automatically. Run `docker compose up -d --build` after Dockerfile changes.

## Development

Run `scripts/setup.sh` from repository root, then `docker compose up -d --build --wait`. Root Compose includes development config under `.docker/compose`. Dependency downloads and offline approved builds complete before web and relay start. Manifest and toolchain hashes skip unchanged installs. Runtime and tooling retain containment described in root README.

Run checks with `docker compose run --rm tools pnpm test`, replacing test with typecheck or build. Dependency mutations use `python3 .docker/dev/dependencies.py mutate` followed by pnpm arguments. This helper exports only validated manifests and lockfile, and stops running development services during writes. Production services are excluded.

Standalone tooling uses `.docker/compose/tooling.yaml`, without host tmux setup or credentials.

Use `python3 .docker/tests/runtime.py` to verify resolved relay HOME points to mounted host home.

### Toolchain pins

Newest stable versions satisfying five-day dependency policy checked on 2026-10-10. Docker images and package
manifests pin versions below. Application library migrations remain separate.

| Tool | Version |
| :--- | :--- |
| Node.js | 26.11.1 |
| npm bootstrap | 12.2.0 |
| pnpm | 12.11.2 |
| Next.js | 16.3.8 |
| React | 19.3.0 |
| TypeScript compiler | 7.0.2 |
| Vitest | 5.0.3 |
| Tailwind CSS | 4.3.3 |

Linter and formatter were removed. Planned replacement is oxlint and oxfmt.
Strict peer checks pass. Root Vitest config runs every workspace project. Web
projects use explicit JSX transform and source patterns. Tooling uses UTF-8 locale for tmux metadata.

