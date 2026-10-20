${CHANGELOG}

## Install

`tmuxde` archives include server, agent and browser UI:

| System | Archive OS | Architectures |
| --- | --- | --- |
| Linux | `linux` | `amd64`, `arm64` |
| macOS | `darwin` | `amd64`, `arm64` |
| FreeBSD | `freebsd` | `amd64`, `arm64` |
| OpenBSD | `openbsd` | `amd64`, `arm64` |
| NetBSD | `netbsd` | `amd64`, `arm64` |
| DragonFly BSD | `dragonfly` | `amd64` |

See [install guide](https://github.com/${REPOSITORY}/blob/${TAG}/docs/INSTALL.md) and [macOS agent launchd guide](https://github.com/${REPOSITORY}/blob/${TAG}/docs/MACOS.md). macOS needs version 13 or newer. macOS and BSD targets are cross-compiled; native runtime tests are not yet in CI.

`tmuxde-stt` is Linux amd64/arm64 only. It embeds Parakeet and Silero models and native speech engine, with no downloads at start. macOS and BSD archives have no bundled speech service.

Linux amd64 example:

```sh
curl -fsSLO https://github.com/${REPOSITORY}/releases/download/${TAG}/tmuxde_${VERSION}_linux_amd64.tar.gz
curl -fsSLO https://github.com/${REPOSITORY}/releases/download/${TAG}/checksums.txt
sha256sum --check --ignore-missing checksums.txt
tar -xzf tmuxde_${VERSION}_linux_amd64.tar.gz
./tmuxde version
```

## Container images

| Image | Digest |
| --- | --- |
| `${IMAGE}:${TAG}` | `${DIGEST}` |
| `${IMAGE}-stt:${TAG}` | `${STT_DIGEST}` |

Both images support linux/amd64 and linux/arm64. Server and agent use the same `tmuxde` image. Stable releases also move the `latest` tag.

## Verify signatures

Images and `checksums.txt` are signed with cosign keyless signing from the release workflow. The certificate identity is the workflow and tag below. Use cosign 3.

```sh
cosign verify ${IMAGE}@${DIGEST} \
  --certificate-identity ${IDENTITY} \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

cosign verify ${IMAGE}-stt@${STT_DIGEST} \
  --certificate-identity ${IDENTITY} \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

cosign verify-blob checksums.txt \
  --bundle checksums.txt.sigstore.json \
  --certificate-identity ${IDENTITY} \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```
