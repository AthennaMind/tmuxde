package repo

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"tmuxde/internal/protocol"
)

// baseline reads the index entry for one guarded file in its own work tree.
func (s *Service) baseline(ctx context.Context, file string) (*protocol.RepoBaseline, error) {
	result := &protocol.RepoBaseline{Kind: "baseline"}
	st, err := os.Stat(file)
	if err != nil {
		return nil, err
	}
	if !st.Mode().IsRegular() {
		return result, nil
	}
	repo, err := s.discover(ctx, filepath.Dir(file))
	if err != nil || repo == nil {
		return result, err
	}
	result.Root = &repo.root
	name, err := filepath.Rel(repo.root, file)
	if err != nil {
		return nil, err
	}
	index, err := s.git(ctx, *repo, []string{"ls-files", "--stage", "--others", "--exclude-standard", "-z", "--", name})
	if err != nil {
		return nil, err
	}
	records := gitRecords(index.content)
	if index.truncated || len(records) != 1 {
		return result, nil
	}
	if records[0] == name {
		empty := ""
		result.Content = &empty
		return result, nil
	}
	meta, path, ok := strings.Cut(records[0], "\t")
	fields := strings.Fields(meta)
	if !ok || path != name || len(fields) != 3 || (fields[0] != "100644" && fields[0] != "100755") || fields[2] != "0" || !hashPattern.MatchString(fields[1]) {
		return result, nil
	}
	// The editor reads checkout text. A raw index blob cannot describe an
	// ident, filter or encoding conversion. Never run a checkout filter here.
	attrs, err := s.git(ctx, *repo, []string{"check-attr", "-z", "ident", "filter", "working-tree-encoding", "--", name})
	if err != nil {
		return nil, err
	}
	values := gitRecords(attrs.content)
	if attrs.truncated || len(values) != 9 {
		return result, nil
	}
	// Each record contains the path, attribute name and effective value.
	for i := 2; i < len(values); i += 3 {
		if values[i] != "unspecified" && values[i] != "unset" {
			return result, nil
		}
	}
	blob, err := s.git(ctx, *repo, []string{"cat-file", "blob", fields[1]})
	if err != nil {
		return nil, err
	}
	if !blob.truncated && !strings.ContainsRune(blob.content, 0) {
		result.Content = &blob.content
	}
	return result, nil
}
