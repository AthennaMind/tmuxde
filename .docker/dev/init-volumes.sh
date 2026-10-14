#!/usr/bin/env bash
set -euo pipefail
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/dependencies/root
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/dependencies/stt
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/dependencies/ui
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/dependencies/packages-crypto
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/dependencies/packages-protocol
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/dependencies/packages-ui-kit
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/workspace-cache
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/ui-vite
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/ui-tooling-metadata
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/ui-dev-metadata
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/go-build
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/go-mod
for volume in /volumes/*; do
  owner="$(stat -c %u:%g "$volume")"
  if [[ "$owner" != "$DEV_UID:$DEV_GID" ]]; then
    chown -R "$DEV_UID:$DEV_GID" "$volume"
  fi
done
