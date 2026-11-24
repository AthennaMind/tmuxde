package repo

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"slices"
	"time"
	"unicode/utf8"

	"tmuxde/internal/protocol"
)

const (
	rootScanEntryLimit  = 100_000
	rootScanResultLimit = 128
)

// repositoryFolder checks the marker only. Git requests validate its contents.
func (s *Service) repositoryFolder(dir string) bool {
	marker := filepath.Join(dir, ".git")
	path, err := s.checked(marker)
	if err != nil || path != marker {
		return false
	}
	info, err := os.Lstat(path)
	return err == nil && (info.IsDir() || info.Mode().IsRegular())
}

func (s *Service) roots(ctx context.Context, path string) (*protocol.RepoRoots, error) {
	base, err := s.checked(path)
	if err != nil {
		return nil, err
	}
	tree, err := os.OpenRoot(base)
	if err != nil {
		return nil, err
	}
	defer tree.Close()
	result := &protocol.RepoRoots{Kind: "roots", Roots: []string{}}
	pending := []string{"."}
	deadline := time.Now().Add(s.opts.Timeout)
	inspected := 0
	for len(pending) > 0 {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		if time.Now().After(deadline) || len(result.Roots) >= rootScanResultLimit {
			result.Truncated = true
			break
		}
		dir := pending[0]
		pending = pending[1:]
		full := filepath.Join(base, dir)
		safe, err := s.checked(full)
		if err != nil || safe != full {
			continue
		}
		f, err := tree.Open(dir)
		if err != nil {
			if dir == "." {
				return nil, err
			}
			result.Truncated = true
			continue
		}
		for {
			entries, readErr := f.ReadDir(128)
			inspected += len(entries)
			if inspected > rootScanEntryLimit || time.Now().After(deadline) || ctx.Err() != nil {
				result.Truncated = true
				pending = nil
				break
			}
			for _, entry := range entries {
				if entry.Name() == ".git" {
					if s.repositoryFolder(full) {
						result.Roots = append(result.Roots, full)
					}
					continue
				}
				if entry.IsDir() && utf8.ValidString(entry.Name()) {
					pending = append(pending, filepath.Join(dir, entry.Name()))
				}
			}
			if readErr != nil {
				if !errors.Is(readErr, io.EOF) {
					result.Truncated = true
				}
				break
			}
		}
		_ = f.Close()
	}
	slices.Sort(result.Roots)
	return result, ctx.Err()
}
