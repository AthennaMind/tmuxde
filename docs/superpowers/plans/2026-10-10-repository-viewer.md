# Repository viewer implementation plan

Goal: Files opens current pane directory and offers file previews and current Git changes on mobile and desktop.

- Add correlated repository requests: context resolves current pane path through tmux, list/read browse allowed paths, status/diff show unstaged/staged/untracked changes. File access always passes path guard. Git commands use argv, no external diff/textconv, bounded output/time, no mutations or network.
- Implement dedicated read-only repository browser with Files/Changes tabs, breadcrumb navigation, filter, file preview, line numbers, inline patch coloring, refresh and explicit empty/error/loading states. Capture pane on open. Ignore stale requests on pane/view changes. Filesystem browser works outside Git repositories.
- Mobile Files tab mounts viewer when opened. Desktop gains Files button and panel. Keep terminal mounted and preserve input focus behavior.
- Docker mounts host home read-only at identical path so tmux cwd resolves. Upload folder remains separate writable bind. Set HOME to host home for denied-root checks and TMUXDE_CONFIG_DIR to writable /tmp state; retain block on host .tmuxde. Add Git runtime. Document mounts and scope.
- Test Git service with isolated repositories: staged/unstaged/new/deleted/renamed files, unborn HEAD, nonrepo, paths with spaces, denied paths, symlinks, binary/large files. Test protocol/policy and browser pane cwd, file navigation, mobile/desktop diff, stale response/error handling. Rebuild/deploy relay+web and verify uploads still work.
