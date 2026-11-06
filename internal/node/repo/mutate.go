package repo

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"tmuxde/internal/protocol"
)

// mutationPath accepts one file, never a directory, pathspec or metadata.
func (s *Service) mutationPath(repo repository, name string) (string, error) {
	if name == "" || strings.ContainsRune(name, 0) || filepath.IsAbs(name) || filepath.Clean(name) != name || name == "." || name == ".." || strings.HasPrefix(name, "../") {
		return "", fail(msgOutsideRepo)
	}
	if slices.Contains(strings.Split(name, "/"), ".git") {
		return "", fail(msgMetadata)
	}
	lexical := filepath.Join(repo.root, name)
	real, err := s.checked(lexical)
	if err != nil {
		return "", err
	}
	if real != lexical || !inside(real, repo.root) || inside(real, repo.gitdir) {
		return "", fail("Symbolic links and Git metadata cannot be changed here")
	}
	info, err := os.Lstat(real)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	if info != nil && !info.Mode().IsRegular() {
		return "", fail(msgNotRegular)
	}
	return real, nil
}

func inChangeScope(entry protocol.RepoStatusEntry, scope string) bool {
	switch scope {
	case "untracked":
		return entry.Index == "?" || entry.Worktree == "?"
	case "staged":
		return entry.Index != " " && entry.Index != "?" && entry.Index != "!"
	case "unstaged":
		return entry.Worktree != " " && entry.Worktree != "?" && entry.Worktree != "!"
	}
	return false
}

// mutate changes one listed file and returns fresh status. Index operations
// include both sides of renames. Discard restores only worktree from index.
func (s *Service) mutate(ctx context.Context, repo repository, action, name, scope string) (*protocol.RepoStatus, error) {
	if !s.mutationMu.TryLock() {
		return nil, fail("Another Git operation is running. Refresh before trying again")
	}
	defer s.mutationMu.Unlock()
	if (action == "stage" && scope != "unstaged" && scope != "untracked") || (action == "unstage" && scope != "staged") || (action == "discard" && scope != "unstaged" && scope != "untracked") {
		return nil, fail("File and matching change scope required")
	}
	if _, err := s.mutationPath(repo, name); err != nil {
		return nil, err
	}
	status, err := s.status(ctx, &repo)
	if err != nil {
		return nil, err
	}
	i := slices.IndexFunc(status.Entries, func(entry protocol.RepoStatusEntry) bool { return entry.Path == name && inChangeScope(entry, scope) })
	if i < 0 {
		return nil, fail("File is no longer in this change group. Refresh Changes")
	}
	entry := status.Entries[i]
	if entry.Index == "U" || entry.Worktree == "U" || entry.Index+entry.Worktree == "AA" || entry.Index+entry.Worktree == "DD" {
		return nil, fail("Resolve merge conflicts before changing this file here")
	}
	paths := []string{name}
	if entry.OriginalPath != nil && ((action == "unstage" && entry.Index == "R") || (action == "stage" && entry.Worktree == "R")) {
		if _, err := s.mutationPath(repo, *entry.OriginalPath); err != nil {
			return nil, err
		}
		paths = append(paths, *entry.OriginalPath)
	}
	var args []string
	switch action {
	case "stage":
		args = append([]string{"add", "--all", "--"}, paths...)
	case "unstage":
		head, err := s.git(ctx, repo, []string{"rev-parse", "--verify", "-q", "HEAD"}, 0, 1)
		if err != nil {
			return nil, err
		}
		if strings.TrimSpace(head.content) == "" {
			args = append([]string{"rm", "--cached", "--force", "--"}, paths...)
		} else {
			args = append([]string{"reset", "--quiet", "HEAD", "--"}, paths...)
		}
	case "discard":
		if scope == "untracked" {
			// Root.Remove cannot follow a swapped parent outside repository.
			root, err := os.OpenRoot(repo.root)
			if err != nil {
				return nil, err
			}
			defer root.Close()
			if err := root.Remove(name); err != nil {
				return nil, err
			}
			return s.status(ctx, &repo)
		}
		args = []string{"restore", "--worktree", "--", name}
	}
	if _, err := s.git(ctx, repo, args); err != nil {
		return nil, failWith("Could not update repository. Refresh before trying again", err)
	}
	return s.status(ctx, &repo)
}
