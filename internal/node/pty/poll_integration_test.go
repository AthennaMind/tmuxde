//go:build integration

package pty

import (
	"errors"
	"os"
	"testing"
	"time"

	cpty "github.com/creack/pty"
	"golang.org/x/sys/unix"
)

func TestIntegrationPTYFromBlockingDescriptor(t *testing.T) {
	master, slave, err := cpty.Open()
	if err != nil {
		t.Fatal(err)
	}
	defer master.Close()
	defer slave.Close()

	// Darwin and FreeBSD create the master with NewFile on a blocking
	// descriptor. Reproduce that setup even when tests run on Linux.
	fd, err := unix.FcntlInt(master.Fd(), unix.F_DUPFD_CLOEXEC, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := unix.SetNonblock(fd, false); err != nil {
		_ = unix.Close(fd)
		t.Fatal(err)
	}
	raw := os.NewFile(uintptr(fd), "blocking-pty")
	defer raw.Close()
	pollable, err := pollableMaster(raw)
	if err != nil {
		t.Fatal(err)
	}
	defer pollable.Close()
	_ = raw.Close()
	if err := pollable.SetReadDeadline(time.Now().Add(20 * time.Millisecond)); err != nil {
		t.Fatalf("master has no poller: %v", err)
	}
	buf := make([]byte, 32)
	if _, err := pollable.Read(buf); !errors.Is(err, os.ErrDeadlineExceeded) {
		t.Fatalf("idle read = %v, want deadline instead of EAGAIN", err)
	}
	if err := pollable.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if _, err := slave.WriteString("live-output"); err != nil {
		t.Fatal(err)
	}
	n, err := pollable.Read(buf)
	if err != nil || string(buf[:n]) != "live-output" {
		t.Fatalf("output after idle = %q, %v", buf[:n], err)
	}
	if _, err := pollable.WriteString("input\n"); err != nil {
		t.Fatal(err)
	}
	if err := slave.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	n, err = slave.Read(buf)
	if err != nil || string(buf[:n]) != "input\n" {
		t.Fatalf("input = %q, %v", buf[:n], err)
	}
}
