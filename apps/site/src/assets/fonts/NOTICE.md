# Vendored OpenGraph fonts

`next/og` (Satori) needs real font data handed to it — it cannot resolve a
font by name, and it throws outright when given none. These four static
weights are the ones the OG cards use.

They are vendored rather than fetched from `fonts.googleapis.com` at build
time because a build that reaches the network is a build that fails when the
network is unavailable: an offline self-hoster, a CI runner that cannot reach
Google, or a Google Fonts outage. That is not hypothetical — it is exactly how
the first CI run on `main` failed.

| File | Family | Weight |
| --- | --- | --- |
| `martian-mono-600.woff` | Martian Mono | 600 |
| `martian-mono-500.woff` | Martian Mono | 500 |
| `ibm-plex-mono-400.woff` | IBM Plex Mono | 400 |
| `ibm-plex-mono-500.woff` | IBM Plex Mono | 500 |

Both families are licensed under the SIL Open Font License 1.1, whose text is
in `OFL.txt` beside this file. They are `.woff` rather than `.woff2` because
that is the format the font parser bundled with `next/og` reads.

- Martian Mono — https://github.com/evilmartians/mono
- IBM Plex Mono — https://github.com/IBM/plex
