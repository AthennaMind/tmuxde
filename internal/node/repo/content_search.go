package repo

import (
	"context"
	"strings"

	"tmuxde/internal/node/files"
	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
)

func (s *Service) contentSearch(ctx context.Context, cwd string, req *client.RepoRequest) (protocol.RepoResult, error) {
	if !s.searchMu.TryLock() {
		return nil, fail("Another file search is running. Try again.")
	}
	defer s.searchMu.Unlock()
	options := files.ContentSearchOptions{Query: deref(req.Query), Include: deref(req.Include), Exclude: deref(req.Exclude), CaseSensitive: req.CaseSensitive != nil && *req.CaseSensitive}
	if err := options.Validate(); err != nil {
		return nil, fail(err.Error())
	}
	start := cwd
	if path := deref(req.Path); path != "" {
		start = resolvePath(cwd, path)
	}
	repository, err := s.discover(ctx, start)
	if err != nil {
		return nil, err
	}
	if repository == nil {
		return nil, fail(msgNotRepository)
	}
	// Git selects current tracked paths and untracked paths outside ignore rules.
	// Content reads still pass file policy individually.
	listed, err := s.git(ctx, *repository, []string{"ls-files", "-z", "--cached", "--others", "--exclude-standard"})
	if err != nil {
		return nil, err
	}
	paths := strings.Split(listed.content, "\x00")
	// Never use an incomplete final path after bounded Git output.
	paths = paths[:len(paths)-1]
	result, err := files.SearchContent(ctx, s.guard, repository.root, paths, options)
	if err != nil {
		return nil, err
	}
	result.Truncated = result.Truncated || listed.truncated
	return result, nil
}
