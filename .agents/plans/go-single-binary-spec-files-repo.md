# Porting spec: relay files and repository

Source of truth for phase 5 of [go-single-binary.md](go-single-binary.md). Extracted 2026-10-12 from the relay sources by a read-only scout. Line numbers at extraction time. Files under `apps/relay/src/`.

## Port notes (traps the Go port must not copy, decided fixes)

1. Git timeouts are accepted as success (`repository-service.ts:208`): a killed process has `error.code === null`, `Number(null) === 0` is in `accepted`. Go: a timeout is an error, "Git request timed out".
2. First upload chunk truncates the target in place (`file-service.ts:306-308`). Interrupted upload plus disconnect cleanup deletes the original. Go: the first chunk creates a temp file next to the target (`.<name>.tmuxde-upload-<hex>`), later chunks append, `final` renames over the target, errors and disconnect remove only the temp file. A failed non final chunk marks the upload failed: later chunks are refused with the first error, the final chunk returns it and ends the upload, so a tail can never be renamed over the target. After `Cleanup` every chunk is refused. Chunked protocol unchanged.
3. Delete and rename act on the realpath, so a symlink's target. Go: operate on the lexical path after the guard passes, `lstat` for delete decisions, never follow a symlink into a recursive delete.
4. Only one level of parent fallback in `realpathResolve`. Go: use the `checked()` algorithm everywhere, resolve every missing ancestor up to `/`, any errno other than ENOENT is an error.
5. Allowed root `/` matches nothing below it (`isWithin` builds prefix `//`). Go: treat `/` specially.
6. Empty `TMUXDE_CONFIG_DIR` denies the working directory. Go: empty means unset.
7. `file:list` applies neither deny nor allow lists to entries. Go: keep listing everything inside an allowed dir (the viewer needs to show `~/.ssh` exists) but mark denied entries so reads fail with the guard, which they do already. No change required, note only.
8. `file:read` has no binary flag. Keep protocol, but detect NUL in the first 8 KiB and return empty content with `truncated:false` plus a clear error? No: protocol has no field. Keep behaviour, note for later.
9. `file:write` cannot create a file (`access(W_OK)` first). Keep, `file:create` exists for that.
10. File writes ignore `readOnly`. Collapses with the full grant.
11. Status keeps a partial last record after truncation. Go: drop the partial record.
12. `/file` opens the lexical path, a check then use race, and does not validate `end < start`. Go: open the resolved path with `O_NOFOLLOW` so a symlink swapped in at the last element after the guard fails with ELOOP (ancestors are not protected, `openat2` with `RESOLVE_NO_SYMLINKS` would close that on Linux, deferred), return 416 on `end < start`.
13. Raw Node errno strings reach the client. Go: map common errors to short messages ("No such file or directory", "Permission denied", "File exists", "Is a directory", "Not a directory"), keep the path out of the message.
15. Rename could move a parent of a denied root (`file:rename ~/.config ~/cfg`) and expose `gh/hosts.yml` through the new name. Relay had the same gap. Go: rename refuses when either form of the old path holds a denied root, and when either side resolves to an allowed root.
16. An allowed root configured through a symlink (`/home` on Fedora Atomic, `/tmp` on macOS) was denied by its own name. Go: the configured root name itself is permitted when its parent resolves inside the roots.
14. Dropped chunks under rate limit silently corrupt an upload. Go: with the temp file approach an out of order or missing chunk still corrupts. Keep the rate limit but exempt nothing; the web file tree sends 64 KiB chunks back to back without ack, so 1 MiB frame cap and 100 msg/s allow 6.4 MB/s. Acceptable, note only.

## 1. Path guards

Allowed roots (`config.ts:9-17,48`): `ALLOWED_PATHS` split on `,`, trimmed, blanks dropped. Default `/home`. Relative entries resolve against the working directory. Realpath'd again on every call.

`realpathResolve(p)` (`file-service.ts:40-53`): `abs = path.resolve(p)`, try realpath, on any error join realpath of the parent with the base name, if that fails return `abs`. One level only (trap 4).

`checked()` in `repository-service.ts:30-45`: on ENOENT resolve every missing ancestor recursively up to `/`, other errno rethrown, then require `isPathAllowed(abs) && isPathAllowed(resolved)` else "Access denied: path outside allowed directories". This is the algorithm to port.

Denied roots (`file-service.ts:71-91`): `home = $HOME`. `configDir = TMUXDE_CONFIG_DIR ?? ~/.tmuxde`. List: `configDir`, `~/.tmuxde`, `~/.tmuxremote`, `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, `~/.kube`. Each realpath resolved once at module load. Not configurable on purpose (comment 65-69). Go: resolve at startup too, document it.

`isWithin(r, root)` (`93-95`): `r === root || r.startsWith(root + "/")`. Rejects `/home/userdata` against `/home/user` and `~/.tmuxdefoo` against `~/.tmuxde`.

`isPathAllowed(p)` (`117-124`): resolve, false if within any denied root, else true if within any resolved allowed root. `assertPathAllowed` returns the resolved path or throws "Access denied: path outside allowed directories".

Callers: router checks `msg.path` for `file:list`, `read`, `stat`, `watch`, `write`, `create`, `mkdir`, `delete`, `upload`, and both `oldPath` and `newPath` for `file:rename` (`message-router.ts:540-728`). Service functions check again. Parents never checked separately. `file:unwatch` unchecked. `/file` checks `?path=`. Repository service `checked()` on every path, `discover` stops at the first parent that fails `isPathAllowed`. Empty or relative path resolves against the working directory. Go: reject empty and relative paths with `ACCESS_DENIED`.

Router guard failure: `error {code:"ACCESS_DENIED", message:"Path outside allowed directories"}`.

## 2. file:* messages

Shared: schemas `client-messages.ts:62-85,109-143`, every `path` is a plain string. Limits: read 100 KiB (102400), write 1 MiB (1048576), upload total 10 MiB (10485760), frame 1 MiB, rate 100 msg/s. One message at a time per connection. Uncaught error in list, read, stat → `error {code:"HANDLER_ERROR", message}`.

`file:list {path}` (`145-171`): readdir with types. Hidden included, no entry limit. Entry `{name, path: join(resolvedDir, name), type, size, modified}`. `type` from the dirent without following links: `file`, `directory`, `symlink`, `other`. `size` and `modified` from `stat` (follows links), entries whose stat fails are skipped. `modified` ISO UTC with ms. Sort: directories first, then `localeCompare` on name (ICU collation; Go: `golang.org/x/text/collate` is a new dependency, so use a case insensitive compare with Unicode simple folding and fall back to byte order, accept the small difference). Symlinks to directories sort as non directories. Reply `file:list {path: msg.path as sent, entries}`.

`file:read {path}` (`173-196`): stat follows links, non regular → "Not a file". Over 102400 bytes: read the first 102400, `truncated:true`. Exactly 102400 not truncated. No binary detection, lossy UTF-8 decode (Go: `strings.ToValidUTF8` with U+FFFD, trim an incomplete trailing sequence). Reply `file:content {path: msg.path, content, truncated}`.

`file:stat {path}` (`198-233`): stat follows links, type never `symlink`. `name` and `path` describe the resolved target. `size`, `modified`, `created` (birthtime, Go: use ctime fallback when birthtime unavailable) ISO. `permissions` `"r"`, `"rw"` or `"-"` from access R then W, W only tried after R. `isReadable`, `isWritable` derived. Reply `file:stat {stat}`.

`file:write {path, content}` (`235-249`): limit in UTF-8 bytes, over → "File too large to write (N bytes, max 1048576)". `access(W_OK)` first so the file must exist. Write in place, not atomic, mode kept, follows symlink target. Reply `file:write:result {path: msg.path, success, size?, error?}`, fallback "Write failed". Go: write via temp file and rename, keep mode.

`file:create {path, content?}` (`251-258`): O_CREAT|O_EXCL mode 0666 & ~umask. Existing → EEXIST. Reply `file:op:result {op:"create", path, success, error?}`, fallback "Create failed".

`file:mkdir {path}` (`260-263`): mkdir non recursive. Fallback "Mkdir failed".

`file:delete {path}` (`265-275`): resolved path equal to any allowed root → "Cannot delete an allowed root directory". Else `rm -r` without force, missing → ENOENT. Operates on the realpath (trap 3). Fallback "Delete failed".

`file:rename {oldPath, newPath}` (`277-284`): rename(2) on resolved paths, overwrites silently, EXDEV not handled, symlink source renames its target (trap 3). Reply `path` is `newPath`. Fallback "Rename failed".

`file:op:result` (`server-messages.ts:168-175`): `{op, path, success, error?, final?}`.

`GET /file?path=...` (`server.ts:544-661`): see the ws lifecycle spec section 5. Additional: HEAD falls through to 404. Opens the lexical path (trap 12).

## 3. Upload

Message `file:upload {path, content: base64, final, ack?}`. Per connection `uploads: Map<resolvedPath, bytesSoFar>` (`file-service.ts:22`, `connection-manager.ts:151`).

Per chunk (`286-318`): guard, lenient base64 decode, `newSize = existing + chunk`. Over 10485760 → delete map entry, `rm -f` target, throw "Upload too large (N bytes, max 10485760)". Size 0 → `writeFile` (create or truncate, trap 2) else `appendFile`. `final` → delete map entry, else store `newSize`.

Replies (`message-router.ts:727-758`): when `final || ack` → `file:op:result {op:"upload", path, success:true}` plus `final: msg.final` only when `ack` set. Plain non final chunks get no reply. Errors reply `success:false` with the error string, fallback "Upload failed".

Clients: feature flag `"file:upload:ack"`. Photo uploader uses 128 KiB chunks with `ack:true` and waits. File tree (`apps/web/.../file-tree.tsx:205-245`) uses 64 KiB chunks back to back, no ack.

Cleanup: on close, after the queue drains, `cleanupUploads` (`324-329`) removes every path still in the map. Go: remove temp files, never the target.

## 4. Watchers

chokidar 4.0.3 (`335-372`): `watch(resolved, {depth:0, ignoreInitial:true, persistent:true})`. Defaults that matter: `atomic: true` (unlink delayed 100 ms, unlink then add within the window becomes `change`), `change` throttled to one per path per 50 ms, `followSymlinks: true`, editor temp files ignored `/\..*\.(sw[px])$|~$|\.subl.*\.tmp/`.

Events `add`, `change`, `unlink`, `addDir`, `unlinkDir` → `file:changed {path: absolute path under the realpath'd dir, event}`. No relay debounce. Errors only logged.

Go with fsnotify: watch the directory non recursively (depth 0). Map Create → `add` or `addDir` (stat), Write → `change`, Remove and Rename → `unlink` or `unlinkDir` (remember type at add time), Chmod ignored. Implement the 100 ms atomic delay and the 50 ms change throttle so editors that write via temp file and rename produce one `change`, not `unlink` plus `add`. Ignore the same temp patterns.

Router (`message-router.ts:569-598`): map key is raw `msg.path`, duplicate is a silent no-op. Success sends no reply. Synchronous throw → `error WATCH_FAILED` with the message or "Failed to watch path". No per connection limit (Go: cap at 32 watchers per connection, `WATCH_FAILED` "Too many watchers"). `file:unwatch` closes without awaiting, ignores unknown paths, no reply. Cleanup on disconnect closes all.

## 5. Repository service (`repository-service.ts`)

Limits (`14-18`): read 100 KiB, git output 512 KiB, 2000 entries, 5000 ms timeout, 100 commits per page.

Router (`message-router.ts:528-537`): ownership rule first (attached session, pane id in `list-panes -s`). Then `pane.path` from `#{pane_current_path}`. Errors "No session attached", "Pane not found", "Pane directory is unavailable". Every error, including ownership denials, comes back as `repo:result {requestId, result:{kind:"error", message}}`.

`textFile` (`57-75`): `checked()`, open O_RDONLY|O_NONBLOCK, non regular → "Not a regular file". Read up to `limit+1`. `binary` = NUL in the first `limit` bytes, then `content` is `""`. `truncated = bytesRead > limit || size > limit`. `metadataFile` (`77-82`) throws "Unsupported Git metadata" if truncated or binary.

`discover(start)` (`125-155`): `root = checked(start)`, must be a directory else "Not a directory". If `root/.git` exists (lstat): `checked(.git)`. If `.git` is a file it must match `/^gitdir: (.+)\r?\n?$/` else "Invalid Git directory pointer", `gitdir = checked(resolve(root, m[1]))`. `validateGitDirectory(gitdir)`. If `gitdir/commondir` exists: `checked(resolve(gitdir, trim(content)))` and validate that too. Else move to the parent. `null` at `/` or when the parent fails `isPathAllowed`.

`validateGitDirectory` (`84-123`): walk the whole tree each request, skip `hooks` and `logs`. Over 100k entries or 5 s → "Git metadata exceeds inspection limit". Any symlink → "Access denied: Git metadata symlinks are unsupported". Non blank `alternates` or `http-alternates` → "Access denied: Git object alternates are unsupported". `config` or `config.worktree` matching `/^\s*\[\s*(?:include(?:if)?|filter)[\s.\]"]/im` → "Access denied: Git configuration includes and filters are unsupported".

Running git (`157-220`): environment is the process env minus every `GIT_*`, plus `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_OPTIONAL_LOCKS=0`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_TERMINAL_PROMPT=0`, `GIT_LITERAL_PATHSPECS=1`, `GIT_NO_LAZY_FETCH=1`, `LC_ALL=C`. Prefix argv:

```
git --no-pager --git-dir <gitdir> --work-tree <root>
    -c core.fsmonitor=false -c core.hooksPath=/dev/null -c core.untrackedCache=false
    -c protocol.allow=never -c diff.submodule=short -c core.quotePath=true <args>
```

cwd `root`, UTF-8 output. Output over 512 KiB → `{content: first 524288 bytes, truncated:true}`. Exit code outside `accepted` (default `[0]`) → "Git request timed out" if killed, else "Could not read repository". Trap 1 applies.

Commands:

- branch: `symbolic-ref --quiet --short HEAD`, accepted `[0,1]`, trimmed, empty → `null`.
- context (`481-487`): `discover(cwd)`, `request.path` ignored. `{kind:"context", path: cwd realpath, root|null, branch|null}`.
- list (`426-462`): `checked(resolve(cwd, path ?? "."))`, readdir. Over 2000 inspected → `truncated`. Each entry `checked()` (denied dropped), stat through links, type `directory`, `file`, `other`. Same sort as `file:list`. `{kind:"list", path, entries, truncated}`.
- read (`471-475`): no path → "File path required". `{kind:"read", path: resolved, content, truncated, binary}`.
- status, diff, log, show discover from `resolve(cwd, request.path)` when `path` given, else `cwd`.
- status (`488-536`): `status --porcelain=v1 -z --untracked-files=all --ignore-submodules=all`. Split on `\0`, drop last. Record: `index = r[0]`, `worktree = r[1]`, `path = r[3:]`. `R` or `C` in either column → next record is `originalPath`. Each path `checked()`, denied hidden. Stop at 2000. `truncated = output.truncated || records > 2000`. No repository → `{root:null, branch:null, entries:[], truncated:false}`.
- diff (`554-598`): no repository → "Current pane directory is not a Git repository". Missing file or scope → "File and change scope required". `file = resolve(root, request.file)` inside `root` else "Access denied: file outside repository", then `checked()`. untracked: built locally from `textFile`, header `--- /dev/null`, `+++ <JSON.stringify(request.file)>`, `@@ -0,0 +1,<n> @@`, `+line` each, then `\ No newline at end of file\n` unless content ends in `\n` or was truncated. Empty or binary → `""`. staged or unstaged: `diff --no-ext-diff --no-textconv --no-color --no-renames --ignore-submodules=all [--cached] -- <absolute file>`. `binary` by `/^Binary files .* differ$/m` or `GIT binary patch`. `{kind:"diff", path: request.file, scope, content, truncated, binary}`.
- log (`257-287`): `rev-parse --verify -q HEAD` accepted `[0,1]`, empty → `commits:[], more:false`. `log --no-show-signature --no-mailmap --no-notes --no-color -z --format=%H%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s --max-count=101 --skip=<skip> --end-of-options HEAD`. Split on `\0`, drop empties, if truncated drop the last record, keep 100. `more = records > 100 || truncated`. Record split on `\x1f`: parents on `" "`, refs on `", "`, subject fields 5 onward rejoined with `\x1f`. No repository → `{root:null, branch:null, skip:0, commits:[], more:false}`.
- show (`347-424`): `commit` must match `/^[0-9a-f]{7,64}$/` else "Invalid commit", missing → "Commit required". `rev-parse --verify -q <c>^{commit}` accepted `[0,1]`, output must match `^[0-9a-f]{40,64}$` else "Commit not found". Metadata `show -s --no-show-signature --no-mailmap --no-notes --no-color --format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%cI%x1f%D%x1f%s%x1f%b --end-of-options <hash>`, body fields 9 onward joined and trimmed. Files `diff-tree -r -z -M --root --raw --numstat -p --no-commit-id --no-abbrev --diff-merges=first-parent --no-ext-diff --no-textconv --no-color --end-of-options <hash>`. Of the first 2000 parsed files, any outside root or failing `checked()` removed and counted in `hidden`. `truncated = output.truncated || files > 2000`.
- `parseCommitTree` (`298-345`), three passes: raw records are tokens starting with `:`, status is the first letter of the last space separated field, `R` or `C` consume two path tokens else one. Then numstat records `/^(-|\d+)\t(-|\d+)\t([^]*)$/`, `-` means null, empty third group means a rename consuming three tokens. Then join the rest, split before each `^diff --git `, pair sections to files by index, strip one trailing `\n`. `binary` when additions is null or the section contains `Binary files ... differ`.

Sanitising: commits hex only, `--end-of-options` before every rev, paths absolute after `--`, `GIT_LITERAL_PATHSPECS=1`, `skip` integer 0 to 1e6, no user supplied ref names.

## 6. Test inventory

`file-service.test.ts`. Setup: `base = realpath(mkdtemp(tmpdir/"relay-fs-"))`, dirs `user`, `userdata`, `user/sub`, `outside` (with `secret.txt`), symlink `user/escape` → `outside`. `HOME=user`, `TMUXDE_CONFIG_DIR=user/service-state`. Dirs `user/.tmuxde` (with `config.json`), `user/.ssh` (with `id_rsa`), `user/.tmuxdefoo` (with `notes.txt`). Symlink `user/shortcut` → `user/.ssh`. `ALLOWED_PATHS=user`.

- "the credential deny-list": refuses host config even when relay state uses another directory; refuses the neighbouring credential directories; refuses a symlink inside the allowed root pointing at a denied one; still allows a sibling that merely shares the prefix; reports the denial directly too
- "isPathAllowed": allows the exact allowed root; allows a subpath of the allowed root; allows a not-yet-existing file inside the allowed root; rejects a sibling directory that merely shares a string prefix; rejects `..` traversal that escapes the allowed root; rejects a symlink inside the allowed root that points outside it

`repository-service.test.ts`. Setup: `base = mkdtemp(tmpdir/"tmuxde-repo-")`, `root = base/repo`, `ALLOWED_PATHS=root`. `git -c commit.gpgsign=false -C root`, `init -q`, user `Test <test@example.invalid>`. Commit "fixture" with `both.txt`, `delete.txt`, `old name.txt`. Then stage `both.txt` = `staged\n`, working copy `working\n`, unlink `delete.txt`, `git mv` to `new name.txt`, untracked file named `:(glob)*\n.txt`. Tests share state in order. "repository reads":

1. reports staged, unstaged, renamed and unusual untracked names
2. separates staged and unstaged diffs
3. handles deleted and literal untracked paths
4. rejects traversal and symlinks outside allowed paths
5. bounds text reads and detects binary files
6. returns a clear non-repository context
7. rejects Git metadata symlink escapes before invoking Git
8. supports staged changes before first commit
9. does not execute fsmonitor, external diff or textconv programs
10. rejects Git pointers and nested metadata escaping allow list
11. supports linked worktrees within allowed paths
12. bounds Git diff output
13. detects binary Git diffs
14. rejects configured clean filters before Git can execute them
15. builds accurate untracked patches with and without final newline
16. keeps selected repository context when pane changes directory

`repository-log.test.ts`. Setup: `base = mkdtemp(tmpdir/"tmuxde-log-")`, `ALLOWED_PATHS=base`, `TMUXDE_CONFIG_DIR=root/secret`. `init -b main`. Commit "root": `a.txt` plus `secret/key`. Commit "rename": `a.txt` → `b.txt` with one changed line, plus binary `bin.dat`, body `Body line one.\n\nBody line two.`. Branch `side` with commit "side", back to `main` with commit "main", `merge --no-ff` "merge". 100 empty commits "empty 0..99", tag `v1`. "repository history":

1. pages the log from HEAD
2. answers an empty history before the first commit and outside Git
3. shows a root commit and hides files denied by policy
4. shows renames, binary files and the body
5. shows a merge against its first parent
6. refuses malformed and unknown commits
7. turns off signature checks that run the configured program

"parseCommitTree": keeps files whose patch was cut off; reads rename counts printed as separate path records

`message-router.test.ts` file and repo parts (mocked file service and tmux, full grant): "upload acknowledgements": acknowledges nonfinal chunks only when requested; keeps legacy intermediate chunks silent. "photo upload completion and permission": acknowledges final chunk after write succeeds. "repository request routing": uses fresh pane directory instead of browser context; correlates permission denials without calling repository service; refuses panes outside attached session; correlates service errors.

`packages/protocol/src/repository.test.ts`: five schema tests, unchanged.

## Comments that record past bugs

- `file-service.ts:58-63`: one `file:read` on a read-only share returned a full shell via `~/.tmuxde/config.json`. Deny list.
- `file-service.ts:112-115`: deny check lives inside `isPathAllowed` because a deny in the wrapper would be bypassed.
- `file-service.ts:17-20`: upload state per connection so concurrent connections cannot corrupt each other's partial files.
- `file-service.ts:299`: remove the partial file so a rejected oversize upload leaves nothing behind.
- `server.ts:581-584`, `435-441`: `/file` accepted any valid token and only checked the path.
- `connection-manager.ts:207-208`: watcher close awaited so fs handles are released.
- `wire-connections.ts:285-287`: `defaultPath` withheld when files are off, it leaks the account name.
- `repository-service.ts:29`: deleted files still need symlink checks. `86-87`: metadata symlinks and alternates bypass file permissions. `231-233`: signature checks run the configured GPG program. `241`: subject goes last so a stray separator only lands in it. `278`: output cut at the limit ends in a partial record.
