package repo

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"tmuxde/internal/protocol"
)

const (
	// stderrLimit caps the Git stderr kept for the log.
	stderrLimit = 4096
	// waitDelay bounds Wait when a stray process keeps a pipe open.
	waitDelay = time.Second
	// fieldSep separates format fields, %x1f in the format strings.
	fieldSep = "\x1f"
)

// gitSettings are added to the environment of every Git call. Every other
// GIT_ variable is removed first.
var gitSettings = []string{
	"GIT_CONFIG_NOSYSTEM=1",
	"GIT_CONFIG_GLOBAL=/dev/null",
	"GIT_OPTIONAL_LOCKS=0",
	"GIT_NO_REPLACE_OBJECTS=1",
	"GIT_TERMINAL_PROMPT=0",
	"GIT_LITERAL_PATHSPECS=1",
	"GIT_NO_LAZY_FETCH=1",
	"LC_ALL=C",
}

// gitConfig comes right after the repository flags on every Git call.
var gitConfig = []string{
	"-c", "core.fsmonitor=false",
	"-c", "core.hooksPath=/dev/null",
	"-c", "core.untrackedCache=false",
	"-c", "protocol.allow=never",
	"-c", "diff.submodule=short",
	"-c", "core.quotePath=true",
}

// historyFlags go on every history read. Signature checks run the
// configured GPG program, and mailmap and notes read more files than the
// commit itself.
var historyFlags = []string{"--no-show-signature", "--no-mailmap", "--no-notes", "--no-color"}

const (
	// Subject last: it is free text, so a stray separator only lands in it.
	logFormat  = "%H%x1f%P%x1f%an%x1f%aI%x1f%D%x1f%s"
	showFormat = "%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%cI%x1f%D%x1f%s%x1f%b"
)

var (
	// hashPattern is a full object name, SHA-1 or SHA-256.
	hashPattern = regexp.MustCompile(`^[0-9a-f]{40,64}$`)

	// binaryPattern is /^Binary files .* differ$/m with JavaScript line
	// terminators.
	binaryPattern = regexp.MustCompile(`(?:\A|[\n\r\x{2028}\x{2029}])Binary files [^\n\r\x{2028}\x{2029}]* differ(?:\z|[\n\r\x{2028}\x{2029}])`)

	// numstatPattern is one --numstat -z record. An empty path means a
	// rename, whose two paths follow as records of their own.
	numstatPattern = regexp.MustCompile(`^(-|[0-9]+)\t(-|[0-9]+)\t((?s:.*))$`)
)

// gitEnv is base without GIT_ variables, LC_ALL and AUTH_TOKEN, plus
// gitSettings.
func gitEnv(base []string) []string {
	env := make([]string, 0, len(base)+len(gitSettings))
	for _, kv := range base {
		k, _, _ := strings.Cut(kv, "=")
		if strings.HasPrefix(k, "GIT_") || k == "LC_ALL" || k == "AUTH_TOKEN" {
			continue
		}
		env = append(env, kv)
	}
	return append(env, gitSettings...)
}

// gitOutput is Git stdout, cut at OutputLimit when truncated is set.
type gitOutput struct {
	content   string
	truncated bool
}

// gitFailure is the detail of a failed Git call, for the log only.
type gitFailure struct {
	command string
	err     error
	stderr  string
}

func (e *gitFailure) Error() string {
	msg := "git " + e.command + ": " + e.err.Error()
	if e.stderr != "" {
		msg += ": " + e.stderr
	}
	return msg
}

func (e *gitFailure) Unwrap() error { return e.err }

// git runs one Git command in repo. Output past OutputLimit is cut and
// marked truncated. An exit code outside accepted, default 0, is "Could
// not read repository". A timeout is "Git request timed out", never a
// success.
func (s *Service) git(ctx context.Context, repo repository, args []string, accepted ...int) (gitOutput, error) {
	if len(accepted) == 0 {
		accepted = []int{0}
	}
	argv := make([]string, 0, 5+len(gitConfig)+len(args))
	argv = append(argv, "--no-pager", "--git-dir", repo.gitdir, "--work-tree", repo.root)
	argv = append(argv, gitConfig...)
	argv = append(argv, args...)

	ctx, cancel := context.WithTimeout(ctx, s.opts.Timeout)
	defer cancel()
	stdout := &capWriter{max: s.opts.OutputLimit, stop: true}
	stderr := &capWriter{max: stderrLimit}
	cmd := exec.CommandContext(ctx, s.bin, argv...)
	cmd.Dir = repo.root
	cmd.Env = s.env
	cmd.Stdout = stdout
	cmd.Stderr = stderr
	// Own process group, so a timeout also ends what Git started.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return killGroup(cmd.Process) }
	cmd.WaitDelay = waitDelay

	err := cmd.Run()
	if stdout.over {
		return gitOutput{content: decodeUTF8(stdout.buf, true), truncated: true}, nil
	}
	if err != nil && !errors.Is(err, exec.ErrWaitDelay) {
		detail := &gitFailure{command: args[0], err: err, stderr: strings.TrimSpace(string(stderr.buf))}
		switch {
		case errors.Is(ctx.Err(), context.DeadlineExceeded):
			return gitOutput{}, failWith(msgTimeout, detail)
		case ctx.Err() != nil:
			return gitOutput{}, failWith(msgCanceled, detail)
		}
		var exit *exec.ExitError
		if !errors.As(err, &exit) || !exit.Exited() || !slices.Contains(accepted, exit.ExitCode()) {
			return gitOutput{}, failWith(msgGitFailed, detail)
		}
	}
	return gitOutput{content: decodeUTF8(stdout.buf, false)}, nil
}

// killGroup kills the process group p leads.
func killGroup(p *os.Process) error {
	err := syscall.Kill(-p.Pid, syscall.SIGKILL)
	if errors.Is(err, syscall.ESRCH) {
		return os.ErrProcessDone
	}
	return err
}

// errOutputLimit stops the copy from the Git stdout pipe. os/exec then
// closes the pipe and Git ends on its next write.
var errOutputLimit = errors.New("output limit reached")

// capWriter keeps the first max bytes. Past max it sets over, and with
// stop it also fails the write.
type capWriter struct {
	buf  []byte
	max  int
	stop bool
	over bool
}

func (w *capWriter) Write(p []byte) (int, error) {
	room := w.max - len(w.buf)
	if len(p) <= room {
		w.buf = append(w.buf, p...)
		return len(p), nil
	}
	w.buf = append(w.buf, p[:room]...)
	w.over = true
	if w.stop {
		return room, errOutputLimit
	}
	return len(p), nil
}

// branch is the short name HEAD points at, nil on a detached HEAD.
func (s *Service) branch(ctx context.Context, repo repository) (*string, error) {
	out, err := s.git(ctx, repo, []string{"symbolic-ref", "--quiet", "--short", "HEAD"}, 0, 1)
	if err != nil {
		return nil, err
	}
	name := jsTrim(out.content)
	if name == "" {
		return nil, nil
	}
	return &name, nil
}

// status lists changed paths. Paths the guard refuses stay out of view.
func (s *Service) status(ctx context.Context, repo *repository) (*protocol.RepoStatus, error) {
	if repo == nil {
		return &protocol.RepoStatus{Kind: "status", Entries: []protocol.RepoStatusEntry{}}, nil
	}
	out, err := s.git(ctx, *repo, []string{"status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"})
	if err != nil {
		return nil, err
	}
	// The last piece is empty, or a record the cap cut off.
	records := strings.Split(out.content, "\x00")
	records = records[:len(records)-1]
	entries := []protocol.RepoStatusEntry{}
	for i := 0; i < len(records) && len(entries) < s.opts.MaxEntries; i++ {
		record := records[i]
		if len(record) < 4 {
			continue
		}
		index, worktree, file := record[0:1], record[1:2], record[3:]
		original := ""
		if isRenameOrCopy(index) || isRenameOrCopy(worktree) {
			i++
			if i >= len(records) {
				// Its original path was cut off. Drop the partial record.
				break
			}
			original = records[i]
		}
		if !s.visible(repo.root, file, original) {
			continue
		}
		entry := protocol.RepoStatusEntry{Path: file, Index: index, Worktree: worktree}
		if original != "" {
			entry.OriginalPath = &original
		}
		entries = append(entries, entry)
	}
	branch, err := s.branch(ctx, *repo)
	if err != nil {
		return nil, err
	}
	return &protocol.RepoStatus{
		Kind:      "status",
		Root:      &repo.root,
		Branch:    branch,
		Entries:   entries,
		Truncated: out.truncated || len(records) > s.opts.MaxEntries,
	}, nil
}

func isRenameOrCopy(code string) bool { return code == "R" || code == "C" }

// visible reports whether the guard allows every non empty name, each
// relative to root. Status does not ask for names to stay inside root.
func (s *Service) visible(root string, names ...string) bool {
	for _, name := range names {
		if name == "" {
			continue
		}
		if _, err := s.checked(resolvePath(root, name)); err != nil {
			return false
		}
	}
	return true
}

// diff is one file's change in one scope. Untracked files get a patch
// built here. Git never reads them.
func (s *Service) diff(ctx context.Context, repo repository, name, scope string) (*protocol.RepoDiff, error) {
	if name == "" || scope == "" || !isRepoScope(scope) {
		return nil, fail(msgFileScope)
	}
	file := resolvePath(repo.root, name)
	if !inside(file, repo.root) {
		return nil, fail(msgOutsideRepo)
	}
	if _, err := s.checked(file); err != nil {
		return nil, err
	}
	result := &protocol.RepoDiff{Kind: "diff", Path: name, Scope: scope}
	if scope == "untracked" {
		t, err := s.textFile(file)
		if err != nil {
			return nil, err
		}
		result.Content = untrackedPatch(name, t)
		result.Truncated = t.truncated
		result.Binary = t.binary
		return result, nil
	}
	args := []string{"diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--ignore-submodules=all"}
	if scope == "staged" {
		args = append(args, "--cached")
	}
	args = append(args, "--", file)
	out, err := s.git(ctx, repo, args)
	if err != nil {
		return nil, err
	}
	result.Content = out.content
	result.Truncated = out.truncated
	result.Binary = binaryPattern.MatchString(out.content) || strings.Contains(out.content, "GIT binary patch")
	return result, nil
}

// untrackedPatch shows a new file as Git would, with the name as JSON in
// the +++ line. Empty and binary files give an empty patch.
func untrackedPatch(name string, t text) string {
	if t.content == "" {
		return ""
	}
	lines := strings.Split(t.content, "\n")
	terminated := strings.HasSuffix(t.content, "\n")
	if terminated {
		lines = lines[:len(lines)-1]
	}
	var b strings.Builder
	b.WriteString("--- /dev/null\n+++ ")
	b.WriteString(jsString(name))
	fmt.Fprintf(&b, "\n@@ -0,0 +1,%d @@\n", len(lines))
	for i, line := range lines {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteByte('+')
		b.WriteString(line)
	}
	b.WriteByte('\n')
	if !terminated && !t.truncated {
		b.WriteString("\\ No newline at end of file\n")
	}
	return b.String()
}

// jsString is JavaScript JSON.stringify for a string. encoding/json would
// also escape U+2028, U+2029 and HTML characters.
func jsString(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(&b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

// history is one page of commits reachable from HEAD.
func (s *Service) history(ctx context.Context, repo repository, skip int) (*protocol.RepoLog, error) {
	branch, err := s.branch(ctx, repo)
	if err != nil {
		return nil, err
	}
	result := &protocol.RepoLog{Kind: "log", Root: &repo.root, Branch: branch, Skip: float64(skip), Commits: []protocol.RepoCommit{}}
	// A new repository has no HEAD commit yet. That is an empty history.
	head, err := s.git(ctx, repo, []string{"rev-parse", "--verify", "-q", "HEAD"}, 0, 1)
	if err != nil {
		return nil, err
	}
	if jsTrim(head.content) == "" {
		return result, nil
	}
	args := []string{"log"}
	args = append(args, historyFlags...)
	args = append(args,
		"-z",
		"--format="+logFormat,
		"--max-count="+strconv.Itoa(s.opts.PageSize+1),
		"--skip="+strconv.Itoa(skip),
		"--end-of-options",
		"HEAD",
	)
	out, err := s.git(ctx, repo, args)
	if err != nil {
		return nil, err
	}
	var records []string
	for _, r := range strings.Split(out.content, "\x00") {
		if r != "" {
			records = append(records, r)
		}
	}
	// Output cut at the limit ends in a partial record.
	if out.truncated && len(records) > 0 {
		records = records[:len(records)-1]
	}
	for _, r := range records[:min(len(records), s.opts.PageSize)] {
		result.Commits = append(result.Commits, summary(strings.Split(r, fieldSep)))
	}
	result.More = len(records) > s.opts.PageSize || out.truncated
	return result, nil
}

// field returns fields[i], or "" past the end.
func field(fields []string, i int) string {
	if i < len(fields) {
		return fields[i]
	}
	return ""
}

// splitList splits a non empty value on sep. Empty gives an empty list.
func splitList(v, sep string) []string {
	if v == "" {
		return []string{}
	}
	return strings.Split(v, sep)
}

// summary reads one logFormat record.
func summary(fields []string) protocol.RepoCommit {
	subject := ""
	if len(fields) > 5 {
		subject = strings.Join(fields[5:], fieldSep)
	}
	return protocol.RepoCommit{
		Hash:    field(fields, 0),
		Parents: splitList(field(fields, 1), " "),
		Author:  field(fields, 2),
		Date:    field(fields, 3),
		Subject: subject,
		Refs:    splitList(field(fields, 4), ", "),
	}
}

// show is one commit with its files and patches.
func (s *Service) show(ctx context.Context, repo repository, commit string) (*protocol.RepoShow, error) {
	if !protocol.RepoCommitPattern.MatchString(commit) {
		return nil, fail(msgInvalidCommit)
	}
	resolved, err := s.git(ctx, repo, []string{"rev-parse", "--verify", "-q", commit + "^{commit}"}, 0, 1)
	if err != nil {
		return nil, err
	}
	hash := jsTrim(resolved.content)
	if !hashPattern.MatchString(hash) {
		return nil, fail(msgCommitNotFound)
	}
	args := []string{"show", "-s"}
	args = append(args, historyFlags...)
	args = append(args, "--format="+showFormat, "--end-of-options", hash)
	meta, err := s.git(ctx, repo, args)
	if err != nil {
		return nil, err
	}
	fields := strings.Split(meta.content, fieldSep)
	body := ""
	if len(fields) > 9 {
		body = jsTrim(strings.Join(fields[9:], fieldSep))
	}
	out, err := s.git(ctx, repo, []string{
		"diff-tree", "-r", "-z", "-M", "--root", "--raw", "--numstat", "-p",
		"--no-commit-id", "--no-abbrev",
		// A merge shows what it brought in over the branch it was merged into.
		"--diff-merges=first-parent",
		"--no-ext-diff", "--no-textconv", "--no-color",
		"--end-of-options", hash,
	})
	if err != nil {
		return nil, err
	}
	all := parseCommitTree(out.content)
	files := []protocol.RepoCommitFile{}
	hidden := 0
	for _, f := range all[:min(len(all), s.opts.MaxEntries)] {
		// Same rule as status: paths the guard refuses stay out of view.
		if s.inRepository(repo.root, f.Path, deref(f.OriginalPath)) {
			files = append(files, f)
		} else {
			hidden++
		}
	}
	return &protocol.RepoShow{
		Kind: "show",
		Root: repo.root,
		Commit: protocol.RepoCommitDetail{
			RepoCommit: protocol.RepoCommit{
				Hash:    hash,
				Parents: splitList(field(fields, 1), " "),
				Author:  field(fields, 2),
				Date:    field(fields, 4),
				Subject: field(fields, 8),
				Refs:    splitList(field(fields, 7), ", "),
			},
			Email:         field(fields, 3),
			Committer:     field(fields, 5),
			CommitterDate: field(fields, 6),
			Body:          body,
		},
		Files:     files,
		Hidden:    float64(hidden),
		Truncated: out.truncated || len(all) > s.opts.MaxEntries,
	}, nil
}

// inRepository is visible plus the rule that every name stays inside root.
func (s *Service) inRepository(root string, names ...string) bool {
	for _, name := range names {
		if name != "" && !inside(resolvePath(root, name), root) {
			return false
		}
	}
	return s.visible(root, names...)
}

// parseCommitTree splits diff-tree -z --raw --numstat -p output into files.
//
// All three formats come from one diff queue, so raw record, count and
// patch section n describe the same file. Output cut at the limit leaves
// the tail without counts or patch.
func parseCommitTree(content string) []protocol.RepoCommitFile {
	tokens := strings.Split(content, "\x00")
	i := 0
	files := []protocol.RepoCommitFile{}
	for i < len(tokens) && strings.HasPrefix(tokens[i], ":") {
		parts := strings.Split(tokens[i], " ")
		status := "M"
		if last := parts[len(parts)-1]; last != "" {
			_, size := utf8.DecodeRuneInString(last)
			status = last[:size]
		}
		pair := status == "R" || status == "C"
		need := 2
		if pair {
			need = 3
		}
		if i+need > len(tokens) {
			break
		}
		f := protocol.RepoCommitFile{Path: tokens[i+1], Status: status}
		if pair {
			original := tokens[i+1]
			f.Path = tokens[i+2]
			f.OriginalPath = &original
		}
		files = append(files, f)
		i += need
	}
	for i < len(tokens) && tokens[i] == "" {
		i++
	}
	type count struct{ additions, deletions *float64 }
	var counts []count
	for len(counts) < len(files) && i < len(tokens) {
		m := numstatPattern.FindStringSubmatch(tokens[i])
		if m == nil {
			break
		}
		counts = append(counts, count{numstat(m[1]), numstat(m[2])})
		// A rename prints its two paths as their own records.
		if m[3] != "" {
			i++
		} else {
			i += 3
		}
	}
	i = min(i, len(tokens))
	patch := strings.TrimLeft(strings.Join(tokens[i:], "\x00"), "\x00")
	sections := patchSections(patch)
	for n := range files {
		section := ""
		if n < len(sections) {
			section = strings.TrimSuffix(sections[n], "\n")
		}
		f := &files[n]
		if n < len(counts) {
			f.Additions = counts[n].additions
			f.Deletions = counts[n].deletions
			f.Binary = counts[n].additions == nil
		}
		f.Binary = f.Binary || binaryPattern.MatchString(section)
		f.Patch = section
	}
	return files
}

// numstat reads one count. "-" means none, for binary files.
func numstat(v string) *float64 {
	if v == "-" {
		return nil
	}
	n, err := strconv.ParseFloat(v, 64)
	if err != nil {
		return nil
	}
	return &n
}

// patchSections splits a patch before every line that starts with
// "diff --git ". Text before the first such line is dropped.
func patchSections(patch string) []string {
	const marker = "diff --git "
	var sections []string
	start := -1
	for at := 0; at < len(patch); {
		if strings.HasPrefix(patch[at:], marker) {
			if start >= 0 {
				sections = append(sections, patch[start:at])
			}
			start = at
		}
		next := strings.IndexByte(patch[at:], '\n')
		if next < 0 {
			break
		}
		at += next + 1
	}
	if start >= 0 {
		sections = append(sections, patch[start:])
	}
	return sections
}
