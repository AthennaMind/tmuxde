package protocol_test

import (
	"errors"
	"strings"
	"testing"

	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/server"
)

func TestRequiredSlice(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{"nil", protocol.RequiredSlice[string]("refs", nil), "refs: must not be null"},
		{"empty", protocol.RequiredSlice("refs", []string{}), ""},
		{"items", protocol.RequiredSlice("refs", []string{"HEAD"}), ""},
		{"nil structs", protocol.RequiredSlice[protocol.PaneInfo]("panes", nil), "panes: must not be null"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ""
			if tt.err != nil {
				got = tt.err.Error()
			}
			if got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}

// TestEncodeRefusesNilSlices covers every required array a server message
// carries. A nil slice would go out as null, which the browser refuses. An
// empty slice goes out as [].
func TestEncodeRefusesNilSlices(t *testing.T) {
	commit := protocol.RepoCommit{Parents: []string{}, Refs: []string{}}
	tests := []struct {
		name      string
		nilMsg    server.Message
		wantErrs  []string
		emptyMsg  server.Message
		wantEmpty string
	}{
		{
			name:      "session:list",
			nilMsg:    &server.SessionList{Type: "session:list"},
			wantErrs:  []string{"sessions: must not be null"},
			emptyMsg:  &server.SessionList{Type: "session:list", Sessions: []protocol.SessionInfo{}},
			wantEmpty: `{"type":"session:list","sessions":[]}`,
		},
		{
			name:      "session:windows",
			nilMsg:    &server.SessionWindows{Type: "session:windows", Name: "a"},
			wantErrs:  []string{"windows: must not be null", "panes: must not be null"},
			emptyMsg:  &server.SessionWindows{Type: "session:windows", Name: "a", Windows: []protocol.WindowInfo{}, Panes: []protocol.PaneInfo{}},
			wantEmpty: `{"type":"session:windows","name":"a","windows":[],"panes":[]}`,
		},
		{
			name:      "window:list",
			nilMsg:    &server.WindowList{Type: "window:list", SessionName: "a"},
			wantErrs:  []string{"windows: must not be null"},
			emptyMsg:  &server.WindowList{Type: "window:list", SessionName: "a", Windows: []protocol.WindowInfo{}},
			wantEmpty: `{"type":"window:list","windows":[],"sessionName":"a"}`,
		},
		{
			name:      "window:changed",
			nilMsg:    &server.WindowChanged{Type: "window:changed", SessionName: "a"},
			wantErrs:  []string{"windows: must not be null"},
			emptyMsg:  &server.WindowChanged{Type: "window:changed", SessionName: "a", Windows: []protocol.WindowInfo{}},
			wantEmpty: `{"type":"window:changed","windows":[],"sessionName":"a"}`,
		},
		{
			name:      "pane:list",
			nilMsg:    &server.PaneList{Type: "pane:list", WindowID: "@1"},
			wantErrs:  []string{"panes: must not be null"},
			emptyMsg:  &server.PaneList{Type: "pane:list", WindowID: "@1", Panes: []protocol.PaneInfo{}},
			wantEmpty: `{"type":"pane:list","panes":[],"windowId":"@1"}`,
		},
		{
			name:      "pane:changed",
			nilMsg:    &server.PaneChanged{Type: "pane:changed", WindowID: "@1"},
			wantErrs:  []string{"panes: must not be null"},
			emptyMsg:  &server.PaneChanged{Type: "pane:changed", WindowID: "@1", Panes: []protocol.PaneInfo{}},
			wantEmpty: `{"type":"pane:changed","panes":[],"windowId":"@1"}`,
		},
		{
			name:      "file:list",
			nilMsg:    &server.FileList{Type: "file:list", Path: "/w"},
			wantErrs:  []string{"entries: must not be null"},
			emptyMsg:  &server.FileList{Type: "file:list", Path: "/w", Entries: []protocol.FileEntry{}},
			wantEmpty: `{"type":"file:list","path":"/w","entries":[]}`,
		},
		{
			name:      "repo list",
			nilMsg:    repoResult(&protocol.RepoList{Kind: "list", Path: "/w"}),
			wantErrs:  []string{"result.entries: must not be null"},
			emptyMsg:  repoResult(&protocol.RepoList{Kind: "list", Path: "/w", Entries: []protocol.FileEntry{}}),
			wantEmpty: `{"type":"repo:result","requestId":"r","result":{"kind":"list","path":"/w","entries":[],"truncated":false}}`,
		},
		{
			name:      "repo status",
			nilMsg:    repoResult(&protocol.RepoStatus{Kind: "status"}),
			wantErrs:  []string{"result.entries: must not be null"},
			emptyMsg:  repoResult(&protocol.RepoStatus{Kind: "status", Entries: []protocol.RepoStatusEntry{}}),
			wantEmpty: `{"type":"repo:result","requestId":"r","result":{"kind":"status","root":null,"branch":null,"entries":[],"truncated":false}}`,
		},
		{
			name:      "repo log",
			nilMsg:    repoResult(&protocol.RepoLog{Kind: "log"}),
			wantErrs:  []string{"result.commits: must not be null"},
			emptyMsg:  repoResult(&protocol.RepoLog{Kind: "log", Commits: []protocol.RepoCommit{}}),
			wantEmpty: `{"type":"repo:result","requestId":"r","result":{"kind":"log","root":null,"branch":null,"skip":0,"commits":[],"more":false}}`,
		},
		{
			name:      "repo log commit",
			nilMsg:    repoResult(&protocol.RepoLog{Kind: "log", Commits: []protocol.RepoCommit{{Hash: "h"}}}),
			wantErrs:  []string{"result.commits[0].parents: must not be null", "result.commits[0].refs: must not be null"},
			emptyMsg:  repoResult(&protocol.RepoLog{Kind: "log", Commits: []protocol.RepoCommit{commit}}),
			wantEmpty: `{"type":"repo:result","requestId":"r","result":{"kind":"log","root":null,"branch":null,"skip":0,"commits":[{"hash":"","parents":[],"author":"","date":"","subject":"","refs":[]}],"more":false}}`,
		},
		{
			name:      "repo show",
			nilMsg:    repoResult(&protocol.RepoShow{Kind: "show", Root: "/w"}),
			wantErrs:  []string{"result.commit.parents: must not be null", "result.commit.refs: must not be null", "result.files: must not be null"},
			emptyMsg:  repoResult(&protocol.RepoShow{Kind: "show", Root: "/w", Commit: protocol.RepoCommitDetail{RepoCommit: commit}, Files: []protocol.RepoCommitFile{}}),
			wantEmpty: `{"type":"repo:result","requestId":"r","result":{"kind":"show","root":"/w","commit":{"hash":"","parents":[],"author":"","date":"","subject":"","refs":[],"email":"","committer":"","committerDate":"","body":""},"files":[],"hidden":0,"truncated":false}}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, err := server.Encode(tt.nilMsg)
			if !errors.Is(err, protocol.ErrInvalid) {
				t.Fatalf("nil slice encoded as %s, error %v", data, err)
			}
			for _, want := range tt.wantErrs {
				if !strings.Contains(err.Error(), want) {
					t.Errorf("error %q does not contain %q", err, want)
				}
			}
			data, err = server.Encode(tt.emptyMsg)
			if err != nil {
				t.Fatalf("empty slice refused: %v", err)
			}
			if string(data) != tt.wantEmpty {
				t.Fatalf("got  %s\nwant %s", data, tt.wantEmpty)
			}
		})
	}
}

func repoResult(r protocol.RepoResult) *server.RepoResult {
	return &server.RepoResult{Type: "repo:result", RequestID: "r", Result: r}
}
