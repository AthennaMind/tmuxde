package repo

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// submoduleChanges asks Git about commit pointers only after checking each
// work tree and its metadata. Untracked files and edits belong to child status.
func (s *Service) submoduleChanges(ctx context.Context, repo repository) (gitOutput, error) {
	modules := filepath.Join(repo.root, ".gitmodules")
	info, err := os.Lstat(modules)
	if errors.Is(err, fs.ErrNotExist) {
		return gitOutput{}, nil
	}
	if err != nil {
		return gitOutput{}, err
	}
	if !info.Mode().IsRegular() || !s.guard.Allowed(modules) {
		return gitOutput{truncated: true}, nil
	}
	scan, cancel := context.WithTimeout(ctx, s.opts.Timeout)
	defer cancel()
	config, err := s.git(scan, repo, []string{"config", "--no-includes", "--null", "--file", modules, "--get-regexp", `^submodule\..*\.path$`}, 0, 1)
	if err != nil {
		return gitOutput{truncated: true}, ctx.Err()
	}
	var paths []string
	listed := make(map[string]bool)
	partial := config.truncated
	for _, record := range gitRecords(config.content) {
		if len(paths) >= rootScanResultLimit || scan.Err() != nil {
			partial = true
			break
		}
		_, name, ok := strings.Cut(record, "\n")
		if ok && !listed[name] && filepath.IsLocal(name) && filepath.Clean(name) == name && name != "." && s.repositoryFolder(filepath.Join(repo.root, name)) {
			paths = append(paths, name)
			listed[name] = true
		}
	}
	if len(paths) == 0 {
		return gitOutput{truncated: partial}, ctx.Err()
	}
	index, err := s.git(scan, repo, append([]string{"ls-files", "--stage", "-z", "--"}, paths...))
	if err != nil {
		return gitOutput{}, err
	}
	// Only pass exact index gitlinks to Git. A directory pathspec would
	// also inspect submodules deeper inside it.
	var checked []string
	partial = partial || index.truncated
	for _, record := range gitRecords(index.content) {
		name := indexedGitlink(record)
		if !listed[name] {
			continue
		}
		full := filepath.Join(repo.root, name)
		if _, err := s.openRepository(scan, full, filepath.Join(full, ".git")); err != nil {
			partial = true
			continue
		}
		checked = append(checked, name)
	}
	if len(checked) == 0 {
		return gitOutput{truncated: partial}, ctx.Err()
	}
	out, err := s.git(scan, repo, append([]string{"status", "--porcelain=v1", "-z", "--untracked-files=no", "--ignore-submodules=dirty", "--"}, checked...))
	out.truncated = out.truncated || partial
	return out, err
}

// indexedGitlink returns the path of an unconflicted gitlink index entry.
func indexedGitlink(record string) string {
	meta, name, ok := strings.Cut(record, "\t")
	if ok && strings.HasPrefix(meta, "160000 ") && strings.HasSuffix(meta, " 0") {
		return name
	}
	return ""
}

// isGitlink verifies one directory before Git can inspect its commit pointer.
func (s *Service) isGitlink(ctx context.Context, repo repository, file string) (bool, error) {
	if !s.repositoryFolder(file) {
		return false, nil
	}
	name, err := filepath.Rel(repo.root, file)
	if err != nil || !filepath.IsLocal(name) || name == "." {
		return false, err
	}
	index, err := s.git(ctx, repo, []string{"ls-files", "--stage", "-z", "--", name})
	if err != nil {
		return false, err
	}
	records := gitRecords(index.content)
	if index.truncated || len(records) != 1 || indexedGitlink(records[0]) != name {
		return false, nil
	}
	_, err = s.openRepository(ctx, file, filepath.Join(file, ".git"))
	return err == nil, err
}
