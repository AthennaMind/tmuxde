#!/usr/bin/env bash
# Refresh vendor/ of the Go module at the repository root after go.mod
# changes. Networked, runs in the go-vendor service. Fails when a required
# module version is younger than five days, the same policy as pnpm
# minimumReleaseAge 7200 minutes.
set -euo pipefail

min_age_minutes=7200
proxy=https://proxy.golang.org

mkdir -p "$HOME"
cd /workspace

# go mod tidy rewrites go.mod and go.sum before the age check runs. Keep
# copies so a failed check can put them back.
backup="$(mktemp -d)"
trap 'rm -rf "$backup"' EXIT
cp go.mod go.sum "$backup"/

go mod tidy

# Module paths and versions on the proxy escape capitals as !lowercase.
escape() {
  sed -E 's/([A-Z])/!\L\1/g' <<<"$1"
}

now="$(date -u +%s)"
failed=0
checked=0
while read -r module version; do
  checked=$((checked + 1))
  url="$proxy/$(escape "$module")/@v/$(escape "$version").info"
  if ! info="$(curl --fail --silent --show-error --location --max-time 30 "$url")"; then
    echo "FAIL $module $version: no release info at $url" >&2
    failed=1
    continue
  fi
  published="$(sed -n 's/.*"Time":"\([^"]*\)".*/\1/p' <<<"$info")"
  if [[ -z "$published" ]] || ! epoch="$(date -u -d "$published" +%s 2>/dev/null)"; then
    echo "FAIL $module $version: release info has no valid Time" >&2
    failed=1
    continue
  fi
  age_minutes=$(((now - epoch) / 60))
  if ((age_minutes < min_age_minutes)); then
    echo "FAIL $module $version published $published, younger than five days" >&2
    failed=1
  else
    echo "ok   $module $version published $published"
  fi
done < <(awk '
  $1 == "require" && $2 == "(" { block = 1; next }
  block && $1 == ")" { block = 0; next }
  block && NF >= 2 { print $1, $2; next }
  $1 == "require" && NF >= 3 { print $2, $3 }
' go.mod)

if ((failed)); then
  cp "$backup"/go.mod "$backup"/go.sum .
  echo "Release age check failed. go.mod and go.sum restored, vendor/ left unchanged. Pin older versions in go.mod." >&2
  exit 1
fi
echo "Release age check passed for $checked modules."

# vendor/ is a bind mount. go mod vendor removes its output dir first, which
# fails on a mount point, so it writes to /tmp and the result is copied in.
staging="$backup/vendor"
go mod vendor -o "$staging"
find vendor -mindepth 1 -delete
cp -a "$staging"/. vendor/
echo "vendor/ refreshed."
