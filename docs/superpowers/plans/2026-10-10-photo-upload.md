# Photo upload implementation plan

Goal: Pick photo on phone or desktop, upload to shared host storage, and insert path into current terminal prompt without Enter.

Architecture: Reuse authenticated file upload protocol with optional per-chunk acknowledgements. Browser sends one chunk at a time, waits for final success, and checks session and pane before inserting path. Relay retains file permission and path guards. Docker mounts upload folder at identical host and container paths.

Stack: React, existing WebSocket protocol, Zod, Docker Compose.

1. Add optional chunk acknowledgements to protocol, relay handler, and browser routing. Test success and denial. Existing clients retain final-only response behavior.
2. Add photo upload helper with format/size checks, sequential chunks, timeout/disconnect handling, and tests. Use unique filenames. Browser converts supported phone image formats to JPEG when needed. Reject undecodable files with readable error.
3. Add shared Photo picker component to desktop header and mobile More controls. Preserve keyboard state. Guard against session changes during upload. Test actual saved bytes and terminal input interception in browser.
4. Update setup script and Compose shared storage. Document retention and paths. Rebuild, deploy, verify host/container file visibility and mobile/desktop interaction.
5. Review changes and fix material findings. No commits required for this local working tree.

Decisions: advertise `file:upload:ack` in auth features; hide Photo on older relays. Use server:info.defaultPath as destination. Setup creates ~/.local/share/tmuxde/uploads with mode 0700, writes LOCAL_UPLOAD_DIR to Compose env, and mounts that absolute path unchanged into relay. ALLOWED_PATHS contains only that folder in local stack.

Completed: protocol and shared mount deployed. 30 web unit tests, 88 relay tests, and 17 browser tests passed. Mobile and desktop browser tests verified original bytes through authenticated download, no Return, preserved hidden keyboard, and closing More during upload. Host files matched test fixture and were removed after verification. Web and relay containers healthy. Review found no blockers; copy-mode insertion and More lifetime concerns addressed. Physical iPhone picker and agent model interpretation remain user checks.
