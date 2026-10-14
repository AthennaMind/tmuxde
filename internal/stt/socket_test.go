package stt

import (
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestListenRemovesAStaleSocket(t *testing.T) {
	path := socketPath(t)
	// A socket nobody listens on, as after SIGKILL.
	dead, err := net.Listen("unix", path)
	if err != nil {
		t.Fatal(err)
	}
	dead.(*net.UnixListener).SetUnlinkOnClose(false)
	dead.Close()
	if info, err := os.Lstat(path); err != nil || info.Mode().Type() != os.ModeSocket {
		t.Fatalf("no stale socket: %v", err)
	}

	if err := serveOn(t, newTestServer(t, &counting{}, startOptions{}), path); err != nil {
		t.Fatal(err)
	}
	if status, _ := health(t, path); status != http.StatusOK {
		t.Fatalf("health %d", status)
	}
}

func TestListenLeavesALiveSocketAlone(t *testing.T) {
	path := socketPath(t)
	if err := serveOn(t, newTestServer(t, &counting{}, startOptions{}), path); err != nil {
		t.Fatal(err)
	}
	err := serveOn(t, newTestServer(t, &counting{}, startOptions{}), path)
	if err == nil || !strings.Contains(err.Error(), "already listens") {
		t.Fatalf("err = %v", err)
	}
	if status, _ := health(t, path); status != http.StatusOK {
		t.Fatalf("health %d", status)
	}
}

func TestListenRefusesAPathThatIsNotASocket(t *testing.T) {
	path := socketPath(t)
	if err := os.WriteFile(path, []byte("keep me"), 0o600); err != nil {
		t.Fatal(err)
	}
	err := serveOn(t, newTestServer(t, &counting{}, startOptions{}), path)
	if err == nil || !strings.Contains(err.Error(), "not a socket") {
		t.Fatalf("err = %v", err)
	}
	if info, err := os.Lstat(path); err != nil || !info.Mode().IsRegular() {
		t.Fatalf("file gone or changed: %v", err)
	}
}
