# Docker development implementation plan

Goal: run installs, development, builds, checks, browser tests and Git hooks in Docker. Remove host dependency contents. Preserve local HTTPS, host tmux, uploads and Caddy volumes.

Architecture: retain production Compose. Add development override using shared toolchain image and Docker volumes for each workspace dependency directory and generated output. Add standalone tooling Compose for checks without host credentials or tmux mounts. Shell wrapper provides host entry point without Node or pnpm.

- [x] Pin current stable toolchain versions in manifests and all Dockerfiles. Generate lockfile inside Docker. Explicitly approve required native dependency builds.
- [x] Add toolchain image, dependency volumes, development override and shell entry point. Runtime services remain on internal network. Package installation uses separate tooling network.
- [x] Route CI, setup and Git hooks through Docker. Document commands and update agent instructions.
- [x] Remove repository node_modules contents. Verify fresh Docker install, lint, typecheck, tests, production builds and development HTTPS. Test hot reload. Preserve deployment volumes and host sessions.

Compatibility: validate ESLint and TypeScript major upgrades against plugin peers and existing configs. Record any required version limits with concrete failures.

Validation: frozen Docker install, clean peer check, lint, typecheck, 1,153 unit tests,
workspace build and both production images pass. HTTPS development login returns
200 with preserved Caddy CA. Onboarding browser checks and isolated Chromium
and WebKit terminal smoke tests pass. Source changes were served without rebuilding
or restarting web container. Host dependency mount points are empty. Existing host
tmux session IDs remain present.
