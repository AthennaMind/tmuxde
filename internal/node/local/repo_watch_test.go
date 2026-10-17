package local

import (
	"context"
	"os"

	"slices"
	"testing"

	"tmuxde/internal/node"

	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

func paneAt(id, dir string) protocol.PaneInfo {
	p := pane(id, "@1")
	if dir != "" {
		p.Path = &dir
	}
	return p
}

// wantWatchResult checks the one reply of a repo:watch.
func wantWatchResult(t *testing.T, sink *fakeSink, root string, ok, partial bool, message string) {
	t.Helper()
	got := only[*server.RepoWatchResult](t, sink)
	if got.OK != ok || got.Partial != partial || deref(got.Root) != anyRoot(root) || deref(got.Message) != anyRoot(message) {
		t.Fatalf("repo:watch:result = root %v ok %v partial %v message %v", deref(got.Root), got.OK, got.Partial, deref(got.Message))
	}
}

// anyRoot is what deref returns for a string field: nil for "".
func anyRoot(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func repoWatchCount(c *conn) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.repoWatchers)
}

func TestRepoWatchRouting(t *testing.T) {
	setup := func(t *testing.T) (*fileHarness, *fakeSink) {
		fh := newFileHarness(t)
		sink := fh.open(1)
		fh.setAttached(1, "work")
		fh.tm.set(func(f *fakeTmux) { f.panes = []protocol.PaneInfo{paneAt("%1", "/w/repo/sub")} })
		fh.repo.roots = map[string]string{"/w/repo/sub": "/w/repo", "/w/repo": "/w/repo", "/w/b": "/w/b", "/w/c": "/w/c"}
		return fh, sink
	}

	t.Run("watches from the fresh pane folder", func(t *testing.T) {
		fh, sink := setup(t)
		fh.must(1, &client.RepoWatch{Type: "repo:watch", ID: "%1"})
		wantWatchResult(t, sink, "/w/repo", true, false, "")
		if got := fh.repo.rootCalls; !slices.Equal(got, []string{"/w/repo/sub"}) {
			t.Fatalf("WatchRoot calls = %v", got)
		}
		if got := fh.tm.called("ListPanes"); !slices.Equal(got, []string{"ListPanes work "}) {
			t.Fatalf("ListPanes calls = %v", got)
		}
		// Changes go out through the connection.
		w := fh.repo.started()[0]
		w.send(&server.RepoChanged{Type: "repo:changed", Root: "/w/repo", Paths: []string{"a.txt"}})
		got := only[*server.RepoChanged](t, sink)
		if got.Root != "/w/repo" || !slices.Equal(got.Paths, []string{"a.txt"}) {
			t.Fatalf("repo:changed = %+v", got)
		}
		// So does the result a watch sends when a later walk hits a cap.
		root := "/w/repo"
		w.send(&server.RepoWatchResult{Type: "repo:watch:result", Root: &root, OK: true, Partial: true})
		wantWatchResult(t, sink, "/w/repo", true, true, "")
	})

	t.Run("passes the captured context path", func(t *testing.T) {
		fh, sink := setup(t)
		fh.must(1, &client.RepoWatch{Type: "repo:watch", ID: "%1", Path: ptr("/w/repo")})
		wantWatchResult(t, sink, "/w/repo", true, false, "")
		if got := fh.repo.rootCalls; !slices.Equal(got, []string{"/w/repo/sub|/w/repo"}) {
			t.Fatalf("WatchRoot calls = %v", got)
		}
	})

	t.Run("a second watch of a root re-acks", func(t *testing.T) {
		fh, sink := setup(t)
		fh.repo.partial = true
		fh.must(1, &client.RepoWatch{Type: "repo:watch", ID: "%1"})
		wantWatchResult(t, sink, "/w/repo", true, true, "")
		fh.must(1, &client.RepoWatch{Type: "repo:watch", ID: "%1", Path: ptr("/w/repo")})
		wantWatchResult(t, sink, "/w/repo", true, true, "")
		if n := len(fh.repo.started()); n != 1 {
			t.Fatalf("started %d watches, want 1", n)
		}
	})

	refusals := []struct {
		name     string
		attached string
		panes    []protocol.PaneInfo
		listErr  error
		id       string
		want     string
	}{
		{name: "refuses without an attach", id: "%1", want: "No session attached"},
		{name: "refuses panes outside attached session", attached: "work", panes: []protocol.PaneInfo{paneAt("%1", "/w/repo")}, id: "%9", want: `Pane "%9" not found`},
		{name: "refuses when the pane lookup fails", attached: "work", listErr: errBoom, id: "%1", want: `Pane "%1" not found`},
		{name: "refuses a pane without a directory", attached: "work", panes: []protocol.PaneInfo{paneAt("%1", "")}, id: "%1", want: "Pane directory is unavailable"},
	}
	for _, tt := range refusals {
		t.Run(tt.name, func(t *testing.T) {
			fh := newFileHarness(t)
			sink := fh.open(1)
			fh.setAttached(1, tt.attached)
			fh.tm.set(func(f *fakeTmux) {
				f.panes = tt.panes
				if tt.listErr != nil {
					f.errs["ListPanes"] = tt.listErr
				}
			})
			fh.must(1, &client.RepoWatch{Type: "repo:watch", ID: tt.id})
			wantWatchResult(t, sink, "", false, false, tt.want)
			if len(fh.repo.rootCalls) != 0 || len(fh.repo.started()) != 0 {
				t.Fatal("repository service ran")
			}
		})
	}

	t.Run("answers service refusals with the public text", func(t *testing.T) {
		fh, sink := setup(t)
		fh.repo.rootErr = node.ErrDenied
		fh.must(1, &client.RepoWatch{Type: "repo:watch", ID: "%1", Path: ptr("relative")})
		wantWatchResult(t, sink, "", false, false, "Access denied: path outside allowed directories")
	})

	t.Run("answers a failed start with the root", func(t *testing.T) {
		fh, sink := setup(t)
		fh.repo.watchErr = os.ErrPermission
		fh.must(1, &client.RepoWatch{Type: "repo:watch", ID: "%1"})
		wantWatchResult(t, sink, "/w/repo", false, false, "Permission denied")
		if n := repoWatchCount(fh.conn(1)); n != 0 {
			t.Fatalf("kept %d watches", n)
		}
	})

	t.Run("caps watches per connection", func(t *testing.T) {
		fh, sink := setup(t)
		fh.n.maxRepoWatchers = 2
		for _, p := range []string{"/w/repo", "/w/b"} {
			fh.must(1, &client.RepoWatch{Type: "repo:watch", ID: "%1", Path: ptr(p)})
			wantWatchResult(t, sink, p, true, false, "")
		}
		fh.must(1, &client.RepoWatch{Type: "repo:watch", ID: "%1", Path: ptr("/w/c")})
		wantWatchResult(t, sink, "/w/c", false, false, "Too many repository watchers")
		// A watched root still re-acks at the cap.
		fh.must(1, &client.RepoWatch{Type: "repo:watch", ID: "%1", Path: ptr("/w/b")})
		wantWatchResult(t, sink, "/w/b", true, false, "")

		// Unwatch frees a slot and sends nothing. A second one is a no op.
		fh.must(1, &client.RepoUnwatch{Type: "repo:unwatch", Root: "/w/repo"})
		fh.must(1, &client.RepoUnwatch{Type: "repo:unwatch", Root: "/w/repo"})
		if got := sink.all(); len(got) != 0 {
			t.Fatalf("unwatch answered %v", typesOf(got))
		}
		if !fh.repo.started()[0].isClosed() {
			t.Fatal("unwatch left the watch running")
		}
		fh.must(1, &client.RepoWatch{Type: "repo:watch", ID: "%1", Path: ptr("/w/c")})
		wantWatchResult(t, sink, "/w/c", true, false, "")
	})

	t.Run("close ends every watch", func(t *testing.T) {
		fh, sink := setup(t)
		for _, p := range []string{"/w/repo", "/w/b"} {
			fh.must(1, &client.RepoWatch{Type: "repo:watch", ID: "%1", Path: ptr(p)})
			wantWatchResult(t, sink, p, true, false, "")
		}
		c := fh.conn(1)
		fh.n.Close(1)
		for _, w := range fh.repo.started() {
			if !w.isClosed() {
				t.Fatalf("watch of %s still runs", w.root)
			}
		}
		if n := repoWatchCount(c); n != 0 {
			t.Fatalf("watches after Close = %d", n)
		}
	})

	t.Run("a watch that starts after close is closed", func(t *testing.T) {
		fh, _ := setup(t)
		c := fh.conn(1)
		fh.n.Close(1)
		// Close detaches. A queued watch that passed the attach check
		// before Close ran still reaches the start.
		c.mu.Lock()
		c.attached = "work"
		c.mu.Unlock()
		if err := fh.n.repoWatch(context.Background(), c, &client.RepoWatch{Type: "repo:watch", ID: "%1"}); err != nil {
			t.Fatal(err)
		}
		started := fh.repo.started()
		if len(started) != 1 || !started[0].isClosed() || repoWatchCount(c) != 0 {
			t.Fatal("watch kept after Close")
		}
	})
}
