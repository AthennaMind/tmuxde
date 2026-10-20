//go:build integration

package tmux

import (
	"os"
	"path/filepath"
	"slices"
	"testing"

	"tmuxde/internal/protocol"
)

func TestIntegrationInventoryWithoutUTF8Locale(t *testing.T) {
	for _, locale := range []string{"", "C"} {
		t.Run("locale="+locale, func(t *testing.T) {
			for _, key := range []string{"LANG", "LC_ALL", "LC_CTYPE"} {
				t.Setenv(key, locale)
			}
			f := newFixture(t)
			f.conf = os.DevNull
			f.tmux(t, "new-session", "-d", "-s", "keep", "sleep 600")
			dir := filepath.Join(f.base, "répertoire")
			if err := os.Mkdir(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			c := New(Options{Socket: f.sock, Dir: dir, DefaultShell: "sleep 600", Launcher: LauncherNone, Logger: quiet})
			ctx := t.Context()
			created, err := c.CreateSession(ctx, "café", dir, "")
			if err != nil {
				t.Fatal(err)
			}
			if created.Name != "café" || created.ID == "" {
				t.Fatalf("created session = %+v, want café with an ID", created)
			}
			sessions, err := c.ListSessions(ctx)
			if err != nil {
				t.Fatal(err)
			}
			i := slices.IndexFunc(sessions, func(s protocol.SessionInfo) bool { return s.Name == created.Name })
			if i < 0 || sessions[i].ID != created.ID {
				t.Fatalf("sessions = %+v, missing created session %+v", sessions, created)
			}
			if err := c.CreateWindow(ctx, created.Name, "éditeur"); err != nil {
				t.Fatal(err)
			}
			windows, err := c.ListWindows(ctx, created.Name)
			if err != nil {
				t.Fatal(err)
			}
			if len(windows) != 2 || windows[1].Name != "éditeur" {
				t.Fatalf("windows = %+v, want second window named éditeur", windows)
			}
			panes, err := c.ListPanes(ctx, created.Name, windows[1].ID)
			if err != nil {
				t.Fatal(err)
			}
			if len(panes) != 1 || panes[0].Path == nil || *panes[0].Path != dir {
				t.Fatalf("panes = %+v, want pane in %s", panes, dir)
			}
			state, err := c.ReadScrollState(ctx, created.Name)
			if err != nil {
				t.Fatal(err)
			}
			if state.Pane != panes[0].ID || state.PaneHeight <= 0 || state.Width <= 0 {
				t.Fatalf("scroll state = %+v, want pane ID and dimensions", state)
			}
		})
	}
}
