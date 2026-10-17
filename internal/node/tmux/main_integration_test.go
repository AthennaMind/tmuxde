//go:build integration

package tmux

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"testing"

	"golang.org/x/sys/unix"
)

// The application scrolling tests need a program inside a tmux pane that
// puts its tty in raw mode, asks for mouse reports and records every byte
// tmux sends it. The relay used a python script. Here the test binary runs
// itself in a pane, switched by these variables.
const (
	// ttyAppEnv picks the mode: sgr, legacy, keys or inline.
	ttyAppEnv = "TMUXDE_TTY_APP"
	// ttyOutEnv names the file stdin is appended to. It is created on the
	// first byte, so a test can check that nothing arrived.
	ttyOutEnv = "TMUXDE_TTY_OUT"
	// ttyReadyEnv names the file created once the modes are written.
	ttyReadyEnv = "TMUXDE_TTY_READY"
)

func TestMain(m *testing.M) {
	if mode := os.Getenv(ttyAppEnv); mode != "" {
		if err := runTTYApp(mode, os.Getenv(ttyOutEnv), os.Getenv(ttyReadyEnv)); err != nil {
			fmt.Fprintln(os.Stderr, "tty app:", err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

// runTTYApp is the relay's scroll-app.py:
//
//   - sgr: alternate screen, mouse 1000 and SGR 1006
//   - legacy: alternate screen, mouse 1000 only
//   - keys: alternate screen, no mouse
//   - inline: no alternate screen, mouse 1000 and SGR 1006
//
// It writes some history first, then the modes, then reads stdin until the
// pane goes away.
func runTTYApp(mode, out, ready string) error {
	if out == "" || ready == "" {
		return errors.New("output and ready files must be set")
	}
	switch mode {
	case "sgr", "legacy", "keys", "inline":
	default:
		return fmt.Errorf("unknown mode %q", mode)
	}
	if err := makeRaw(0); err != nil {
		return err
	}
	b := bytes.Repeat([]byte("old shell history\r\n"), 100)
	if mode != "inline" {
		b = append(b, "\x1b[?1049h"...)
	}
	if mode != "keys" {
		b = append(b, "\x1b[?1000h"...)
	}
	if mode == "sgr" || mode == "inline" {
		b = append(b, "\x1b[?1006h"...)
	}
	if err := writeAll(1, b); err != nil {
		return err
	}
	if err := os.WriteFile(ready, nil, 0o600); err != nil {
		return err
	}
	buf := make([]byte, 8192)
	for {
		n, err := unix.Read(0, buf)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil || n <= 0 {
			// The pane was killed. EIO or EOF on the tty.
			return nil
		}
		if err := appendFile(out, buf[:n]); err != nil {
			return err
		}
	}
}

// makeRaw is cfmakeraw on fd, as python tty.setraw did.
func makeRaw(fd int) error {
	t, err := unix.IoctlGetTermios(fd, unix.TCGETS)
	if err != nil {
		return fmt.Errorf("get termios: %w", err)
	}
	t.Iflag &^= unix.IGNBRK | unix.BRKINT | unix.PARMRK | unix.ISTRIP |
		unix.INLCR | unix.IGNCR | unix.ICRNL | unix.IXON
	t.Oflag &^= unix.OPOST
	t.Lflag &^= unix.ECHO | unix.ECHONL | unix.ICANON | unix.ISIG | unix.IEXTEN
	t.Cflag &^= unix.CSIZE | unix.PARENB
	t.Cflag |= unix.CS8
	t.Cc[unix.VMIN] = 1
	t.Cc[unix.VTIME] = 0
	if err := unix.IoctlSetTermios(fd, unix.TCSETS, t); err != nil {
		return fmt.Errorf("set termios: %w", err)
	}
	return nil
}

func writeAll(fd int, b []byte) error {
	for len(b) > 0 {
		n, err := unix.Write(fd, b)
		if errors.Is(err, unix.EINTR) {
			continue
		}
		if err != nil {
			return err
		}
		b = b[n:]
	}
	return nil
}

func appendFile(path string, b []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return err
	}
	if _, err := f.Write(b); err != nil {
		_ = f.Close()
		return err
	}
	return f.Close()
}
