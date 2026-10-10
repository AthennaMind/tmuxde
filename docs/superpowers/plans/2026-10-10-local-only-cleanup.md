# Local-only cleanup

Goal: Keep working Docker web, relay, Caddy and host tmux integration. Remove unused hosted products and telemetry paths.

Architecture: Browser talks to same-origin Caddy. Caddy routes local web and relay. Relay uses host tmux and allowed host files. No hosted broker, account, billing, email or published CLI required.

## Work

- [x] Remove apps/site, apps/api, apps/cli and apps/docs runtime. Preserve technical documentation as static reference files.
- [x] Remove packages/db, packages/email, unused packages/config and billing plans after checking consumers.
- [x] Remove hosted web routes, account dependencies and external endpoint configuration. Preserve local pairing, saved machines and local app lock.
- [x] Replace obsolete root scripts, Docker manifests, CI publish wiring and setup documentation with local stack commands.
- [x] Audit active relay and browser for telemetry, CDN assets and automatic outbound requests. Disable framework telemetry during development, build and runtime. Restrict browser resource origins through Caddy.
- [x] Regenerate lockfile. Build both active Docker images and run relevant unit and browser tests.
- [x] Deploy web and relay without deleting volumes or host sessions. Verify health, local pairing, terminal, file viewer and upload controls, plus browser request origins.

Validation: Production build and TypeScript checks, relay and web unit suites, isolated tmux browser smoke test with request capture, Docker internal-network verification, Caddy config validation. Dependency downloads remain necessary when building fresh images. User-run terminal commands retain their existing host network behavior.

## Results

Docker web and relay rebuilt and healthy. Caddy reloaded without replacing CA storage. 1,153 unit tests and 15 browser checks passed. Type checks passed. Lint passed with two existing warnings. Browser trace showed only same-origin requests while using terminal, Files and Settings. Token login, photo uploads on mobile and desktop, scroll gestures, syntax highlighting and file icons passed. Host sessions and original uploads preserved.
