# Manual native updates

Settings reads local inventory until user clicks Check for updates. Check contacts
GitHub's latest stable release endpoint for `AthennaMind/tmuxde`. Explicit Update
pins that snapshot, downloads assets, verifies them and stages every selected
component. Agents update serially, followed by selected speech and server last.
Speech is never selected automatically. One batch runs at a time.

## Supported installations

Native server, agent and speech commands run application child behind lightweight
parent supervisor. No service manager is required. Foreground launches, systemd,
launchd and other managers use same flow. Parent keeps original launch arguments,
environment and working directory. Worker still clears credentials before spawning
tmux, Git or shell commands. Parent never runs user commands or opens terminal PTYs.
Docker processes skip supervisor and updates remain disabled for those components.

Executable and private update directory must be writable by running user. Shared
executable with multiple native supervisors cannot update until other instance
stops. Give server and agent separate installations when both run on same machine.
Read-only or foreign-owned installations show reason instead of attempting sudo.

Speech discovers binary, PID and native supervisor through configured private Unix
socket. No service name or install path setting is needed. Version and active
session count are checked before staging and restarting. Older speech binaries
need manual bootstrap. Model cache stays intact.

Runtime tests cover Linux. Code cross-builds for every released macOS and BSD
target. Native macOS and BSD runtime checks remain outside current environment.

## Release trust

GitHub metadata alone cannot authorize executable. Signed `checksums.txt` must
verify through Sigstore bundle against embedded trusted root, transparency proof,
certificate transparency and exact GitHub Actions issuer and release workflow tag.
Verification stays offline. Release URLs are fixed to this repository; redirects
are restricted to GitHub release hosts. Archives have compressed and expanded size
limits. Extraction writes only expected executable and rejects links, traversal,
duplicates and special files. Candidate must report expected version.

Compatibility lives in Go, with no extra release manifest or CI-generated JSON.
After signature and archive verification, staging runs candidate `version --json`.
Both binaries report release version, communication protocol and updater protocol.
Version must match selected tag. Both protocols must match running binary. Every
selected component passes staging before any component restarts. Check for updates
only reads release metadata, so incompatible releases are rejected after download.
Stable versions compare semantically. Custom, dirty, prerelease and post-tag builds
cannot self-update or downgrade.

For breaking server, agent or speech wire changes, bump `ProtocolVersion` in
[`internal/buildinfo/info.go`](../buildinfo/info.go). Machine handshake and updater
read that same constant. Additive compatible changes need no bump. Incompatible
releases require coordinated manual upgrade; accepting protocol ranges would also
require implementing negotiation and support for both versions.

`UpdateProtocol` in same file covers supervisor control, readiness and update
streams. Change it only when those contracts break. Such updates require manual
install and full process restart because supervisor stays loaded across updates.
Release version still comes from Git tag through existing GoReleaser build flags.

`trusted-root.json` was fetched on 2026-11-04 with sigstore-go v1.4.0
`root.FetchTrustedRoot()`, which verifies Sigstore TUF metadata, then marshalled
with `TrustedRoot.MarshalJSON()`. Maintainers refresh this file through verified
TUF before required trust rotation. Never accept root material from a release.
Verification tests use published v0.0.6 checksums and bundle from:

- [Checksums](https://github.com/AthennaMind/tmuxde/releases/download/v0.0.6/checksums.txt)
- [Sigstore bundle](https://github.com/AthennaMind/tmuxde/releases/download/v0.0.6/checksums.txt.sigstore.json)

These public fixtures validate offline certificate, tag and artifact binding.
Those binaries predate compatibility reporting and cannot be installed by updater.

## Transactions and recovery

Hub saves snapshot, request IDs and current job under config directory `updates/`.
Each native installation reserves private sibling directory `.tmuxde-update/`
or `.tmuxde-stt-update/`. It contains transaction JSON, staged candidate, previous
executable and startup receipt. Atomic writes sync files and directories.

Apply prepares transaction through supervisor's private Unix control socket.
Parent signals application child to shut down. Child closes connections and exits
with reserved code 75. Parent installs only when that code matches authorized
transaction. Normal exits and crashes propagate their exit status without updates.
Parent PID stays alive, so service manager does not restart or kill its process
group. Tmux processes keep running. Parent also owns liveness pipe. Child shuts down
if parent dies; workers never inherit that pipe.

After graceful shutdown, parent verifies hashes, keeps previous executable and
atomically replaces installed file. It launches new child with original settings.
New process confirms version, digest and PID after local startup. Failed startup
restores previous executable and requires matching recovery receipt. Backup remains
available. Failed rollback keeps reservation and reports manual recovery required.

Agent readiness confirms local node and connection configuration. Hub coordinator
also waits for agent to reconnect before continuing batch. Network outage alone
does not cause repeated rollback of locally healthy agent.

Already authorized installation can recover from journal on next native launch.
Recovery waits for previous application child to exit before restarting it.
Staged downloads alone never authorize installation. Supervisor itself remains
loaded until normal application restart. Candidate must support its update
protocol during that lifetime.

Hub restart never replays apply. Status reads transaction result after reconnect.
Preparation interrupted by hub restart requires explicit Cancel update to release
staged files. Agent must reconnect for remote cleanup. Existing installations need
one manual upgrade to first updater-capable release. No release is published by
building or testing this feature.
