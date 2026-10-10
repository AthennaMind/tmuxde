#!/usr/bin/env bash
set -euo pipefail
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/dependencies/root
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/dependencies/apps-relay
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/dependencies/apps-web
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/dependencies/packages-cast
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/dependencies/packages-crypto
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/dependencies/packages-logger
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/dependencies/packages-protocol
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/dependencies/packages-ui
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/dependencies/tooling-eslint
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/dependencies/tooling-prettier
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/dependencies/tooling-typescript
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/turbo
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/apps-relay-turbo
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/apps-web-turbo
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/packages-cast-turbo
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/packages-crypto-turbo
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/packages-logger-turbo
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/packages-protocol-turbo
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/packages-ui-turbo
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/tooling-eslint-turbo
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/tooling-prettier-turbo
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/tooling-typescript-turbo
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/web-dev
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/web-build
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/web-e2e
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/web-lab
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/web-dist
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/relay-dist
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/test-results
install -d -o "$DEV_UID" -g "$DEV_GID" /volumes/cache/playwright-report
for metadata in web-tooling-metadata web-dev-metadata web-lab-metadata; do
  directory="/volumes/cache/$metadata"
  install -d -o "$DEV_UID" -g "$DEV_GID" "$directory"
  if [[ ! -f "$directory/next-env.d.ts" ]]; then
    printf '%s\n' '/// <reference types="next" />' '/// <reference types="next/image-types/global" />' > "$directory/next-env.d.ts"
    chown "$DEV_UID:$DEV_GID" "$directory/next-env.d.ts"
  fi
done
for volume in /volumes/*; do
  owner="$(stat -c %u:%g "$volume")"
  if [[ "$owner" != "$DEV_UID:$DEV_GID" ]]; then
    chown -R "$DEV_UID:$DEV_GID" "$volume"
  fi
done
