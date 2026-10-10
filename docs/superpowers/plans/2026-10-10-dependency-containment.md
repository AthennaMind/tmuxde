# Dependency containment implementation plan

Goal: Match Uniffy dependency manager flow with fewer volumes and tighter access.

Architecture: Shared dependency and cache volumes use subdirectories. Installer receives manifests only. Downloads run without lifecycle scripts. Approved builds run without network. Lockfile and manifest hashes skip unchanged installs. Runtime uses read-only dependencies and source mounts. Lab tests execute inside isolated lab without Docker socket.

Tech stack: Docker Compose subpath mounts, pnpm 12, Node 26, Python host orchestration.

- [x] Add dependency manager, volume initialization and hash synchronization.
- [x] Consolidate 30 development volumes into three. Preserve Caddy data and upload storage.
- [x] Drop capabilities, forbid privilege escalation, use nonroot users and read-only filesystems.
- [x] Replace lab Docker socket and host networking with commands inside isolated lab.
- [x] Verify fresh install, skipped install, lint, typecheck, tests, build, HTTPS and source reload.
- [x] Remove obsolete development volumes after successful deployment. Update docs.

Checks: Compose configuration must resolve. Installer must have no host home, tmux, secret or daemon mounts. Offline builds must use network none. Source and dependency writes must fail in runtime. Existing host sessions and Caddy volumes must remain. HTTPS login must return 200.

Validation: lint, typecheck, workspace build, both production image builds and 1,153 unit tests passed. Five onboarding browser tests and four isolated relay browser tests passed. Full browser suite encountered existing device-lock fixture failure waiting for Set a PIN. HTTPS source reload and existing Caddy CA verified. Removed 29 obsolete volumes.
