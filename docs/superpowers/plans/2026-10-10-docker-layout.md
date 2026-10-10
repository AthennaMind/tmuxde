# Docker layout consolidation

Goal: Root docker-compose.yml, .docker implementation files and plain Docker Compose interface, following Uniffy layout.

- [x] Merge production base plus development overlay into standalone development config. Root Compose includes it.
- [x] Move runtime assets and credentials without changing volume names, token or CA.
- [x] Remove ordinary command wrappers. Keep setup, safe dependency mutation, hooks and lab helpers internal under .docker.
- [x] Update hooks, CI, docs and build contexts. Remove obsolete wrappers.
- [x] Verify Compose modes, containment, unchanged-install skip, HTTPS source reload and deployed browser terminal round trip.

Keep production config separate for explicit production use. Tooling and lab remain independent Compose projects. No host Node commands. No volume removal.

Validation: root Compose startup and unchanged native download/build skip passed. Production, tooling and lab configurations resolve. Host ID 1000 and override 1234 checks passed. Unit test tasks and typecheck passed. Deployed HTTPS browser attached to isolated host session and completed input/output round trip. Four Chromium/WebKit lab tests passed. Hot reload and preserved CA verified. No manage.py or host Node dependencies. Lab stopped after verification.
