// Package accesslog records who connected to this machine and for how long.
// Port of apps/relay/src/access-log.ts.
//
// It records authentication and disconnection, not activity. One line when
// a browser authenticates and one when its socket closes. Keystrokes and
// file paths are never logged. That would make the log a better target than
// the machine it audits, and the terminal keeps its own history anyway.
//
// The file is NDJSON, append only, mode 0600, named access.log in the config
// directory. A failed write never reaches the caller. A full disk or a read
// only home must never refuse someone access to their own machine.
package accesslog

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// FileName is the log file inside the config directory.
const FileName = "access.log"

// Kind is what happened.
type Kind string

const (
	// Connected is written once a browser has authenticated.
	Connected Kind = "connected"
	// Disconnected is written when an authenticated socket closes.
	Disconnected Kind = "disconnected"
)

// Transport values. See Transport.
const (
	Loopback = "loopback"
	LAN      = "lan"
)

// atLayout matches JavaScript toISOString for UTC times.
const atLayout = "2006-01-02T15:04:05.000Z07:00"

// Event is one entry of the log.
type Event struct {
	// At is when it happened. Record uses the current time when At is zero.
	At time.Time
	// Kind is Connected or Disconnected.
	Kind Kind
	// Label names the device. Empty is written as null.
	Label string
	// Transport is how the peer reached the server, Loopback or LAN.
	Transport string
	// Seconds is how long the socket lived, rounded to whole seconds. It is
	// written for Disconnected only.
	Seconds int
}

// line is an event on disk. Field order is the key order.
//
// The grant fields keep the relay format. They always describe the full
// grant, which is the only credential the hub admits: the machine's own
// AUTH_TOKEN. It has no id, reaches every session and may write files.
type line struct {
	At        string  `json:"at"`
	Event     Kind    `json:"event"`
	GrantID   *string `json:"grantId"`
	Scope     string  `json:"scope"`
	ReadOnly  bool    `json:"readOnly"`
	Files     string  `json:"files"`
	Label     *string `json:"label"`
	Transport string  `json:"transport"`
	Seconds   *int    `json:"seconds,omitempty"`
}

// Path is the log file for a config directory.
func Path(dir string) string {
	return filepath.Join(dir, FileName)
}

// Transport says how a peer reached the server, from its address. It takes
// a bare IP or host:port. An empty address is loopback. IPv4 mapped IPv6 is
// unwrapped first. Only 127.0.0.1, ::1 and localhost count as loopback.
// Everything else is LAN, an unparsable address included.
//
// The relay also had a tunnel transport, named by the tunnel agent user
// agent. The tunnel is gone, so the rule is too.
func Transport(addr string) string {
	if host, _, err := net.SplitHostPort(addr); err == nil {
		addr = host
	}
	if addr == "" {
		return Loopback
	}
	switch strings.TrimPrefix(addr, "::ffff:") {
	case "127.0.0.1", "::1", "localhost":
		return Loopback
	}
	return LAN
}

// Logger appends events to the access log of one config directory. It is
// safe for concurrent use. A nil Logger records nothing.
//
// The hub makes one Logger per process. So the first write error is logged
// once per process, as in the relay, without global state.
type Logger struct {
	dir  string
	log  *slog.Logger
	mu   sync.Mutex
	warn sync.Once
}

// New returns a Logger for dir, which should be an absolute path. The
// caller resolves it from config. dir is created on the first write. log
// takes the one warning about a failed write. Nil means slog.Default().
func New(dir string, log *slog.Logger) *Logger {
	if log == nil {
		log = slog.Default()
	}
	return &Logger{dir: dir, log: log}
}

// Record appends ev as one line. It writes synchronously, never returns an
// error and never panics. The first failure is logged once. Later failures
// are dropped, so a read only home does not turn every connection into a
// warning.
func (l *Logger) Record(ev Event) {
	if l == nil {
		return
	}
	data, err := encode(ev)
	if err == nil {
		err = l.append(data)
	}
	if err != nil {
		l.warn.Do(func() {
			l.log.Warn("access log write failed", "path", Path(l.dir), "error", err)
		})
	}
}

func encode(ev Event) ([]byte, error) {
	at := ev.At
	if at.IsZero() {
		at = time.Now()
	}
	out := line{
		At:        at.UTC().Format(atLayout),
		Event:     ev.Kind,
		Scope:     "all",
		ReadOnly:  false,
		Files:     "write",
		Transport: ev.Transport,
	}
	if ev.Label != "" {
		out.Label = &ev.Label
	}
	if ev.Kind == Disconnected {
		out.Seconds = &ev.Seconds
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	// JSON.stringify leaves <, > and & alone. So does this.
	enc.SetEscapeHTML(false)
	// Encode ends the line with a newline.
	if err := enc.Encode(out); err != nil {
		return nil, fmt.Errorf("encode access event: %w", err)
	}
	return buf.Bytes(), nil
}

// append writes one encoded line. The mutex keeps lines whole and in order
// across connections.
func (l *Logger) append(data []byte) error {
	l.mu.Lock()
	defer l.mu.Unlock()

	if err := os.MkdirAll(l.dir, 0o700); err != nil {
		return fmt.Errorf("create access log directory: %w", err)
	}
	f, err := os.OpenFile(Path(l.dir), os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		return fmt.Errorf("open access log: %w", err)
	}
	// Every time, before the write. A log created by hand or by an older
	// version with a wider mode is tightened before it gets a new line.
	if err := f.Chmod(0o600); err != nil {
		f.Close()
		return fmt.Errorf("chmod access log: %w", err)
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		return fmt.Errorf("write access log: %w", err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("close access log: %w", err)
	}
	return nil
}

// Read returns the events in the log of dir, oldest first. A missing log
// gives no events and no error. Blank and unparsable lines are skipped. A
// truncated final line is what a kill -9 in the middle of a write leaves,
// and it must not hide the lines that are intact.
func Read(dir string) ([]Event, error) {
	data, err := os.ReadFile(Path(dir))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read access log: %w", err)
	}
	var events []Event
	for raw := range bytes.Lines(data) {
		raw = bytes.TrimSpace(raw)
		if len(raw) == 0 {
			continue
		}
		if ev, ok := parse(raw); ok {
			events = append(events, ev)
		}
	}
	return events, nil
}

// parse reads one line. It refuses anything but a JSON object and a time
// that is present but unreadable.
func parse(raw []byte) (Event, bool) {
	if raw[0] != '{' {
		return Event{}, false
	}
	var in line
	if err := json.Unmarshal(raw, &in); err != nil {
		return Event{}, false
	}
	ev := Event{Kind: in.Event, Transport: in.Transport}
	if in.At != "" {
		at, err := time.Parse(time.RFC3339Nano, in.At)
		if err != nil {
			return Event{}, false
		}
		ev.At = at
	}
	if in.Label != nil {
		ev.Label = *in.Label
	}
	if in.Seconds != nil {
		ev.Seconds = *in.Seconds
	}
	return ev, true
}
