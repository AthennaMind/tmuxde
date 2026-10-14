package stt

import (
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"syscall"
	"time"
)

// Listen listens on the unix socket at path. A socket file left by a
// killed service is removed first. Closing the listener removes the file
// again.
func Listen(path string) (net.Listener, error) {
	if err := RemoveStaleSocket(path); err != nil {
		return nil, err
	}
	return net.Listen("unix", path)
}

// RemoveStaleSocket removes a socket file left behind by a killed service.
//
// Close removes the file, but SIGKILL or an OOM kill skips it and the next
// listen fails with EADDRINUSE. Only a socket that refuses connections is
// removed. A live socket or any other file is an error.
func RemoveStaleSocket(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode().Type() != fs.ModeSocket {
		return fmt.Errorf("%s exists and is not a socket", path)
	}
	live, err := answers(path)
	if err != nil {
		return err
	}
	if live {
		return fmt.Errorf("Something already listens on %s", path)
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// answers reports whether a process accepts connections on the socket.
func answers(path string) (bool, error) {
	conn, err := net.DialTimeout("unix", path, time.Second)
	if err == nil {
		conn.Close()
		return true, nil
	}
	if errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ENOENT) {
		return false, nil
	}
	return false, err
}
