${CHANGELOG}

## Install

Linux archives for amd64 and arm64 are attached. `tmuxde` serves the UI and manages local tmux. `tmuxde-stt` is the optional speech binary with bundled models.

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

Images and `checksums.txt` are signed with cosign keyless signing from the release workflow. The certificate identity is the workflow and tag below.

```sh
cosign verify ${IMAGE}@${DIGEST} \
  --certificate-identity ${IDENTITY} \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

cosign verify ${IMAGE}-stt@${STT_DIGEST} \
  --certificate-identity ${IDENTITY} \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

cosign verify-blob checksums.txt \
  --certificate checksums.txt.pem \
  --signature checksums.txt.sig \
  --certificate-identity ${IDENTITY} \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```
