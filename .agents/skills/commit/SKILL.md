---
name: commit
description: Create conventional commits for uncommitted changes, matching tmuxde history style
disable-model-invocation: true
---

# Commit: Create Conventional Commit

Commits should read like existing tmuxde history. When unsure about tone, read `git log -15 --format='%s%n%n%b---'`.

## Process

### 1. Review changes

Run in parallel:

```bash
git status
git diff HEAD
git log -10 --format='%s%n%n%b---'
```

`git diff HEAD` skips untracked files. Read them too.

### 2. Group changes

One commit per topic. A feature travels with its tests, its `packages/protocol/PROTOCOL.md` update and its plan, backlog and review under `.agents/`. `pnpm-lock.yaml` goes with the `package.json` change behind it.

Unrelated work in the tree gets separate commits. Example: markdown preview next to new app icons. When there is more than one group, show the proposed split before committing.

### 3. Stage files

Add paths explicitly. No `git add -A`, `git add .` or `git add -f`.

Never stage:

- `.env`, `.docker/.env.token` or any relay token
- `.docker/host-tmux/` (generated host binary) and `.docker/certs/` (local CA root)
- `AGENTS.local.md`, `CLAUDE.local.md`
- `.playwright-cli/`, `data/`, screenshots or logs from verification runs

All of these are gitignored. If one shows up in `git status`, stop and tell the user.

### 4. Write message

```
<type>(<scope>): <short description>

<body>

<optional footer>
```

**Types:** `feat`, `fix`, `refactor`, `perf`, `docs`, `test`, `chore`, `style`

**Scopes** follow repository layout:

| Scope | Covers |
| --- | --- |
| `web` | `apps/web` |
| `relay` | `apps/relay` |
| `stt` | `apps/stt` |
| `protocol` | `packages/protocol` |
| `crypto`, `ui`, `logger` | matching `packages/*` |
| `infra` | `.docker`, Caddyfile, compose files |
| `scripts` | `scripts/setup.sh` and helpers |
| `agents` | `.agents` skills, plans and reviews |
| `deps` | dependency bumps only |

Leave scope out when change spans several areas, for example a feature across relay, protocol and web. Older history uses upstream scopes `cli`, `site`, `api` and `ci`. Those parts are gone. Do not reuse them.

**Subjects** from history:

```
feat: optional local speech to text dictation
feat: git history view, tab context menu and quieter pane switches
feat(web): settings as a main-area tab
fix: tree splits land in their window, files view follows pane
refactor: remove session recording end to end
docs: reframe as IDE with tmux backend and drop archived docs
chore: drop machine-specific domain and address from tracked files
refactor!: rename project to tmuxde
```

Scoped samples:

```
feat(web): markdown preview for repository files
fix(relay): select pane window through attached session
feat(protocol): repo:request log and show actions
chore(infra): route /_sessions to relay in Caddyfile
chore(agents): add commit and pr skills
```

**Body** says what changed for the user first, then notable relay, protocol or security detail. Short plain sentences. Wrap at 72 columns.

- Single topic: one or two paragraphs.
- Several parts: `- ` bullets. Large changes group bullets under bare header lines such as `Sidebar`, `Main area`, `Keys`.
- Say `Documented in PROTOCOL.md.` when protocol changed.
- Last line points to plan, backlog or review when one exists.

Bullet body:

```
feat: git history view, tab context menu and quieter pane switches

- Tab bar has a right click menu: Close all, Close diffs, Close files.
  Commit tabs count as diffs. The terminal tab never closes.
- History sidebar view lists commits from HEAD of the active pane's
  repository, 100 per page.
- repo:request gains log and show actions behind the repo:history
  feature. History reads disable signature checks, mailmap and notes, so
  repository config never runs a GPG program. Documented in PROTOCOL.md.

Plan and progress in .agents/plans/git-history.md and its backlog.
```

Paragraph body:

```
fix: tree splits land in their window, files view follows pane

Relay selectPane selects the pane's window through the attached session,
since select-pane alone keeps the current window. Session monitor
signature gains pane focus and folder, window poll every 1s.

Session tree matches live panes by window id. Files view refetches on
active pane folder change and keeps last context and listings until the
next answer lands, so switching panes no longer blanks or reloads.
```

**Breaking changes** add `!` after type or scope and a `BREAKING CHANGE:` footer. Use them when users must act: Docker project, network or volume renames, relay env var renames, storage key changes that force sign in or lock re-enrollment, protocol messages old clients cannot read.

```
refactor!: rename project to tmuxde

...

BREAKING CHANGE: Docker project, network, volume and image names change
from mtmux-dev to tmuxde. A new Caddy volume means a new local CA that
devices must trust again. Relay env var MTMUX_CONFIG_DIR becomes
TMUXDE_CONFIG_DIR.
```

### 5. Commit

Pass message through heredoc so wrapping survives:

```bash
git commit -F - <<'EOF'
feat(web): markdown preview for repository files

...
EOF
```

Run `git status` afterwards and report result.

## Rules

- Subject under 72 characters, lowercase after colon, no trailing period.
- Imperative ("drop", "remove") or noun phrase naming the feature ("settings as a main-area tab"). Never past tense.
- NEVER use emojis. No em dashes or double hyphens.
- Never include machine-specific values: real domain, LAN addresses, CA fingerprint, tokens. They live only in `AGENTS.local.md`.
- NEVER include co-author trailers or tool attribution lines.
- Keep repo-local author identity. No `--author`, no git config changes.
- Always a new commit. No amend, rebase, `--no-verify` or push unless user asks. Push and PR belong to `pr` skill.
