# TmuxDE Updates

You decide when TmuxDE checks for updates and what it installs. Open Settings, check for a newer release, then choose which components to update. Nothing checks GitHub on startup, login or a timer.

## Update from Settings

1. Open **Settings > Updates**.
2. Click **Check for updates**. TmuxDE checks the latest stable GitHub release and shows available versions.
3. Click **Update** beside a component, or select several and click **Update selected**.
4. Review your selection and confirm. Downloads start after confirmation.
5. After updating the server, click **Reload updated UI** to load its new browser files.

Server, remote agents and optional speech service appear separately. Speech is never selected for you. Finish any active dictation before updating it.

Opening Settings only reads local status. Checking for updates does not download binaries or install anything. Server contacts GitHub for checks and downloads. Remote agents receive their update through server and do not need GitHub access.

## What can update

Settings can update native release binaries. This works whether you start TmuxDE from a terminal, systemd, launchd or another service manager. No particular service manager is required.

Running user must own the binary and be able to write to its directory. Agents must be connected. If a component cannot update, Settings shows why.

Docker containers, custom builds and installations where several running instances share one binary need manual updates. Update containers through your container setup. Use [install guide](INSTALL.md#update) for manual binary updates.

Existing installations need one manual upgrade to a release that includes this updater. After that, compatible stable releases can update from Settings. Updater does not install prereleases or downgrade versions.

## What happens during an update

TmuxDE downloads and verifies every selected component before restarting anything. It checks release signatures, file checksums and binary compatibility. An incompatible release stops here and requires a coordinated manual upgrade.

Agents update one at a time, followed by speech if selected, then server last. Browser connections briefly disconnect as their server or agent restarts. Tmux sessions keep running. Your settings, workspaces and speech models stay in place.

Each installation keeps its previous binary. If the new process fails to start, updater attempts to restore that version. If a component fails, remaining components stop updating. Components already updated stay on their new version.

You can cancel while downloads are being prepared. Once installation starts, let it finish. Closing browser does not cancel an accepted update.

## If something goes wrong

Return to **Settings > Updates** to read progress. **Waiting for reconnect** means TmuxDE is waiting to hear from that component. Check its connection and process before starting another update.

**Previous version restored** means rollback succeeded. **Manual recovery required** means it did not. Check process logs and restore a verified release using your normal installation method.

If preparation was interrupted, use **Cancel update** to clear it before trying again. Remote agents must reconnect for their cleanup to finish.

Update records and previous binaries stay on disk for recovery. They do not schedule future checks or installs. [Implementation notes](../internal/update/README.md) cover their locations, verification and restart behavior.

## When maintaining releases

Release version comes from Git tag through existing release build. There is no separate update manifest to generate or edit in CI.

Compatibility lives in [internal/buildinfo/info.go](../internal/buildinfo/info.go):

- Bump `ProtocolVersion` when server, agent or speech communication changes break compatibility. Compatible additions keep the same number.
- Change `UpdateProtocol` when update transport or restart contracts break. Those changes require manual install and full process restart.

Both binaries report these values through `version --json`. Updater reads them from verified download before installation. Changing a number does not make incompatible versions work together. Breaking releases need manual upgrade instructions covering affected components.
