package machine

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tmuxde/internal/config"
	"tmuxde/internal/hub/filehttp"
	"tmuxde/internal/node"
	"tmuxde/internal/node/local"
	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

type messageSink chan server.Message

func (s messageSink) Send(ctx context.Context, msg server.Message) error {
	select {
	case s <- msg:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func receive(t *testing.T, sink messageSink, kind string) server.Message {
	t.Helper()
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()
	for {
		select {
		case msg := <-sink:
			if msg.WireType() == kind {
				return msg
			}
			if msg.WireType() == "error" {
				t.Fatalf("unexpected response: %+v", msg)
			}
		case <-timer.C:
			t.Fatalf("timeout waiting for %s", kind)
		}
	}
}

func waitFor(t *testing.T, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatal("condition timed out")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func realNode(t *testing.T) (*local.Node, string) {
	t.Helper()
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Fatal("integration test requires tmux")
	}
	root := t.TempDir()
	socket := filepath.Join(root, "tmux.sock")
	n := local.New(config.Config{
		Home:             root,
		ConfigDir:        filepath.Join(root, "state"),
		AllowedPaths:     []string{root},
		TmuxSocket:       socket,
		TmuxDefaultShell: "/bin/sh",
		TmuxLauncher:     "none",
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := n.Start(t.Context()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		n.Stop()
		_ = exec.Command("tmux", "-S", socket, "kill-server").Run()
	})
	return n, root
}

func startAgent(t *testing.T, hub *Hub, site *httptest.Server, n *local.Node, name string) (Record, *Agent, context.CancelFunc) {
	t.Helper()
	record, token, err := Edit(hub.Dir, "add", name)
	if err != nil {
		t.Fatal(err)
	}
	a := &Agent{
		URL:   site.URL,
		Token: token,
		Node:  n,
		Files: n,
		Info: Info{
			Hostname: name,
			Platform: "linux",
			Version:  "test",
			Features: []string{},
		},
	}
	stop := connectAgent(t, hub, site, a, record.ID)
	return record, a, stop
}

func connectAgent(t *testing.T, hub *Hub, site *httptest.Server, a *Agent, id string) context.CancelFunc {
	t.Helper()
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = a.connect(ctx, site.Client())
	}()
	stop := func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Error("agent did not release streams on cancellation")
		}
	}
	t.Cleanup(stop)
	waitFor(t, func() bool {
		hub.mu.Lock()
		defer hub.mu.Unlock()
		return hub.links[id] != nil
	})
	return stop
}

func TestTwoAgentsAndReconnect(t *testing.T) {
	hub := NewHub(t.TempDir(), strings.Repeat("b", 32))
	mux := http.NewServeMux()
	mux.Handle("/", hub)
	mux.Handle(filehttp.Path, filehttp.New(filehttp.Options{
		Token: hub.BrowserToken,
		Resolve: func(id string) (node.FileOpener, error) {
			_, opener, _, _, err := hub.Resolve(id)
			return opener, err
		},
	}))
	site := httptest.NewTLSServer(mux)
	t.Cleanup(site.Close)
	t.Cleanup(hub.Close)

	first, firstRoot := realNode(t)
	second, secondRoot := realNode(t)
	a, agent, stopA := startAgent(t, hub, site, first, "alpha")
	b, _, _ := startAgent(t, hub, site, second, "beta")
	ctx := t.Context()
	nodes := make([]node.Node, 0, 2)
	for _, record := range []Record{a, b} {
		n, _, _, _, err := hub.Resolve(record.ID)
		if err != nil {
			t.Fatal(err)
		}
		sink := make(messageSink, 256)
		nodes = append(nodes, n)
		if err := n.Open(ctx, 1, sink); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { n.Close(1) })
		name := "dev"
		if err := n.Handle(ctx, 1, &client.SessionCreate{Type: "session:create", Name: &name}); err != nil {
			t.Fatal(err)
		}
		created := receive(t, sink, "session:created").(*server.SessionCreated)
		if created.Session.Name != "dev" {
			t.Fatalf("wrong session: %+v", created)
		}
		capture := true
		if err := n.Handle(ctx, 1, &client.SessionAttach{
			Type:    "session:attach",
			Name:    "dev",
			Capture: &capture,
			Size:    &protocol.TerminalSize{Cols: 80, Rows: 24},
		}); err != nil {
			t.Fatal(err)
		}
		receive(t, sink, "session:attached")
	}

	// Both tmux servers start with the same pane identity. Requests still route
	// through distinct agent streams even when browser connection IDs match.
	for i, record := range []Record{a, b} {
		output, err := exec.Command("tmux", "-S", filepath.Join([]string{firstRoot, secondRoot}[i], "tmux.sock"), "list-panes", "-t", "dev", "-F", "#{pane_id}").Output()
		if err != nil || strings.TrimSpace(string(output)) != "%0" {
			t.Fatalf("%s pane: %q, %v", record.Name, output, err)
		}
	}

	if err := nodes[0].Handle(ctx, 1, &client.TerminalInput{
		Type: "terminal:input",
		Data: "printf alpha > machine-marker\r",
	}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		data, err := os.ReadFile(filepath.Join(firstRoot, "machine-marker"))
		return err == nil && string(data) == "alpha"
	})
	if _, err := os.Stat(filepath.Join(secondRoot, "machine-marker")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("terminal input crossed machine boundary")
	}

	payload := bytes.Repeat([]byte("remote-file\n"), 20000)
	path := filepath.Join(firstRoot, "data.txt")
	if err := os.WriteFile(path, payload, 0600); err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, site.URL+"/file?machine="+a.ID+"&path="+path, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+hub.BrowserToken)
	req.Header.Set("Range", "bytes=65530-140000")
	res, err := site.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || res.StatusCode != http.StatusPartialContent || !bytes.Equal(got, payload[65530:140001]) {
		t.Fatalf("range download: status %d, bytes %d, error %v", res.StatusCode, len(got), err)
	}
	_, files, _, _, err := hub.Resolve(b.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := files.OpenFile(ctx, path); !errors.Is(err, node.ErrDenied) {
		t.Fatalf("other machine path must be denied, got %v", err)
	}

	// Uploads use their own connection and commit only after final acknowledgement.
	uploadSink := make(messageSink, 256)
	if err := nodes[0].Open(ctx, 42, uploadSink); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(firstRoot, "upload.bin")
	if err := os.WriteFile(target, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	ack := true
	sendChunk := func(data []byte, final bool) {
		t.Helper()
		if err := nodes[0].Handle(ctx, 42, &client.FileUpload{
			Type: "file:upload", Path: target, Content: base64.StdEncoding.EncodeToString(data), Final: final, Ack: &ack,
		}); err != nil {
			t.Fatal(err)
		}
		result := receive(t, uploadSink, "file:op:result").(*server.FileOpResult)
		if !result.Success || result.Final == nil || *result.Final != final {
			t.Fatalf("upload response: %+v", result)
		}
	}
	sendChunk(payload[:100000], false)
	if data, err := os.ReadFile(target); err != nil || string(data) != "original" {
		t.Fatalf("partial upload touched target: %q %v", data, err)
	}
	nodes[0].Close(42)
	waitFor(t, func() bool {
		matches, _ := filepath.Glob(filepath.Join(firstRoot, ".upload.bin.tmuxde-upload-*"))
		return len(matches) == 0
	})
	if data, err := os.ReadFile(target); err != nil || string(data) != "original" {
		t.Fatalf("cancel touched target: %q %v", data, err)
	}
	if err := nodes[0].Open(ctx, 42, uploadSink); err != nil {
		t.Fatal(err)
	}
	sendChunk(payload[:100000], false)
	sendChunk(payload[100000:], true)
	nodes[0].Close(42)
	if data, err := os.ReadFile(target); err != nil || !bytes.Equal(data, payload) {
		t.Fatalf("uploaded bytes: %d %v", len(data), err)
	}
	if _, err := os.Stat(filepath.Join(secondRoot, "upload.bin")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("upload crossed machines")
	}
	req, err = http.NewRequestWithContext(ctx, http.MethodGet, site.URL+"/file?machine="+a.ID+"&download=1&path="+target, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+hub.BrowserToken)
	res, err = site.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	got, err = io.ReadAll(res.Body)
	res.Body.Close()
	if err != nil || res.StatusCode != http.StatusOK || !bytes.Equal(got, payload) || !strings.Contains(res.Header.Get("Content-Disposition"), "attachment") {
		t.Fatalf("uploaded download: status %d bytes %d error %v", res.StatusCode, len(got), err)
	}

	stopA()
	waitFor(t, func() bool {
		_, _, _, _, err := hub.Resolve(a.ID)
		return err != nil
	})
	// Agent loss closes attachments, not the tmux server or session.
	if err := exec.Command("tmux", "-S", filepath.Join(firstRoot, "tmux.sock"), "has-session", "-t", "dev").Run(); err != nil {
		t.Fatalf("session lost with agent: %v", err)
	}
	connectAgent(t, hub, site, agent, a.ID)
	n, _, _, _, err := hub.Resolve(a.ID)
	if err != nil {
		t.Fatal(err)
	}
	sink := make(messageSink, 256)
	if err := n.Open(ctx, 1, sink); err != nil {
		t.Fatal(err)
	}
	defer n.Close(1)
	if err := n.Handle(ctx, 1, &client.SessionList{Type: "session:list"}); err != nil {
		t.Fatal(err)
	}
	list := receive(t, sink, "session:list").(*server.SessionList)
	if len(list.Sessions) != 1 || list.Sessions[0].Name != "dev" {
		t.Fatalf("sessions after reconnect: %+v", list.Sessions)
	}
	if _, _, err := Edit(hub.Dir, "revoke", b.ID); err != nil {
		t.Fatal(err)
	}
	waitFor(t, func() bool {
		hub.mu.Lock()
		defer hub.mu.Unlock()
		return hub.links[b.ID] == nil
	})
	select {
	case <-nodes[1].(*remote).Done(1):
	case <-time.After(time.Second):
		t.Fatal("revoked machine kept browser stream alive")
	}

}

// Separate tmux servers reuse pane IDs. Search must return each machine's
// own history over its inventory stream, without attaching either terminal.
func TestRemoteTerminalSearch(t *testing.T) {
	hub := NewHub(t.TempDir(), strings.Repeat("b", 32))
	site := httptest.NewTLSServer(hub)
	t.Cleanup(site.Close)
	t.Cleanup(hub.Close)
	for _, name := range []string{"alpha", "beta"} {
		n, root := realNode(t)
		script := filepath.Join(root, "output.sh")
		if err := os.WriteFile(script, []byte("printf 'search-marker-"+name+"\\n'\nexec sleep 3600\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		socket := filepath.Join(root, "tmux.sock")
		if out, err := exec.Command("tmux", "-S", socket, "new-session", "-d", "-s", "same", "sh "+script).CombinedOutput(); err != nil {
			t.Fatalf("fixture: %s, %v", out, err)
		}
		waitFor(t, func() bool {
			out, err := exec.Command("tmux", "-S", socket, "capture-pane", "-p", "-t", "same").Output()
			return err == nil && strings.Contains(string(out), "search-marker-")
		})
		record, _, _ := startAgent(t, hub, site, n, name)
		remote, _, _, _, err := hub.Resolve(record.ID)
		if err != nil {
			t.Fatal(err)
		}
		sink := make(messageSink, 16)
		if err := remote.Open(t.Context(), 1, sink); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { remote.Close(1) })
		if err := remote.Handle(t.Context(), 1, &client.TerminalSearch{
			Type: "terminal:search", RequestID: "same-request", Query: "search-marker-", ExcludeSessions: []string{},
		}); err != nil {
			t.Fatal(err)
		}
		reply := receive(t, sink, "terminal:search:result").(*server.TerminalSearchResult)
		if reply.Error != nil || reply.Partial || len(reply.Matches) != 1 || reply.Matches[0].PaneID != "%0" || reply.Matches[0].Text != "search-marker-"+name {
			t.Fatalf("%s search crossed machine boundary: %+v", name, reply)
		}
	}
}

func TestRegistryAndAuthentication(t *testing.T) {
	hub := NewHub(t.TempDir(), strings.Repeat("b", 32))
	record, token, err := Edit(hub.Dir, "add", "machine")
	if err != nil {
		t.Fatal(err)
	}
	state, err := os.ReadFile(filepath.Join(hub.Dir, "machines.json"))
	if err != nil || bytes.Contains(state, []byte(token)) {
		t.Fatal("registry contains plaintext credential or cannot be read")
	}
	for _, test := range []struct {
		path  string
		token string
		want  int
	}{
		{MachinesPath, token, http.StatusUnauthorized},
		{AgentPath, hub.BrowserToken, http.StatusUnauthorized},
		{MachinesPath, hub.BrowserToken, http.StatusOK},
	} {
		req := httptest.NewRequest(http.MethodGet, test.path, nil)
		req.Header.Set("Authorization", "Bearer "+test.token)
		res := httptest.NewRecorder()
		hub.ServeHTTP(res, req)
		if res.Code != test.want {
			t.Fatalf("%s status %d, want %d", test.path, res.Code, test.want)
		}
		if strings.Contains(res.Body.String(), record.Hash) || strings.Contains(res.Body.String(), token) {
			t.Fatal("HTTP response exposed credential")
		}
	}
	_, replacement, err := Edit(hub.Dir, "rotate", record.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := hub.record(token); err == nil {
		t.Fatal("old token accepted after rotation")
	}
	if _, err := hub.record(replacement); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Edit(hub.Dir, "revoke", record.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := hub.record(replacement); err == nil {
		t.Fatal("revoked token accepted")
	}
}
