package accesslog

import (
	"bytes"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

var t0 = time.Date(2026, 9, 9, 0, 0, 0, 0, time.UTC)

// quiet returns a Logger whose warnings go to buf.
func quiet(dir string, buf *bytes.Buffer) *Logger {
	return New(dir, slog.New(slog.NewTextHandler(buf, nil)))
}

func mode(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

func TestTransport(t *testing.T) {
	tests := []struct {
		name  string
		addrs []string
		want  string
	}{
		{
			name:  "calls a loopback peer loopback",
			addrs: []string{"127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost", ""},
			want:  Loopback,
		},
		{
			name:  "calls anything else lan",
			addrs: []string{"192.168.1.44", "::ffff:10.0.0.2", "unknown", "127.0.0.2", "fe80::1"},
			want:  LAN,
		},
		{
			name:  "reads the host of a loopback host:port",
			addrs: []string{"127.0.0.1:52100", "[::1]:443", "[::ffff:127.0.0.1]:80", "localhost:24200"},
			want:  Loopback,
		},
		{
			name:  "reads the host of a lan host:port",
			addrs: []string{"192.168.1.44:52100", "[::ffff:10.0.0.2]:80", "[fe80::1]:443"},
			want:  LAN,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			for _, addr := range tt.addrs {
				if got := Transport(addr); got != tt.want {
					t.Errorf("Transport(%q) = %q, want %q", addr, got, tt.want)
				}
			}
		})
	}
}

// TestRecordLine checks every line byte for byte. That covers the key
// order, the time format and the full grant fields.
func TestRecordLine(t *testing.T) {
	tests := []struct {
		name string
		ev   Event
		want string
	}{
		{
			// The machine's own AUTH_TOKEN. There is no share to name.
			name: "records the full grant as scope all with no id",
			ev:   Event{At: t0, Kind: Connected, Transport: Loopback},
			want: `{"at":"2026-09-09T00:00:00.000Z","event":"connected","grantId":null,"scope":"all","readOnly":false,"files":"write","label":null,"transport":"loopback"}`,
		},
		{
			name: "adds seconds on a disconnect",
			ev:   Event{At: t0.Add(time.Minute), Kind: Disconnected, Label: "iPhone", Transport: LAN, Seconds: 60},
			want: `{"at":"2026-09-09T00:01:00.000Z","event":"disconnected","grantId":null,"scope":"all","readOnly":false,"files":"write","label":"iPhone","transport":"lan","seconds":60}`,
		},
		{
			name: "writes seconds zero on a short disconnect",
			ev:   Event{At: t0, Kind: Disconnected, Transport: LAN},
			want: `{"at":"2026-09-09T00:00:00.000Z","event":"disconnected","grantId":null,"scope":"all","readOnly":false,"files":"write","label":null,"transport":"lan","seconds":0}`,
		},
		{
			name: "leaves seconds off a connect",
			ev:   Event{At: t0, Kind: Connected, Transport: LAN, Seconds: 5},
			want: `{"at":"2026-09-09T00:00:00.000Z","event":"connected","grantId":null,"scope":"all","readOnly":false,"files":"write","label":null,"transport":"lan"}`,
		},
		{
			name: "writes UTC with milliseconds",
			ev: Event{
				At:        time.Date(2026, 9, 9, 2, 30, 15, 123456789, time.FixedZone("CEST", 2*3600)),
				Kind:      Connected,
				Transport: LAN,
			},
			want: `{"at":"2026-09-09T00:30:15.123Z","event":"connected","grantId":null,"scope":"all","readOnly":false,"files":"write","label":null,"transport":"lan"}`,
		},
		{
			name: "does not escape html characters in a label",
			ev:   Event{At: t0, Kind: Connected, Label: `Tom's <tab> & "pad"`, Transport: LAN},
			want: `{"at":"2026-09-09T00:00:00.000Z","event":"connected","grantId":null,"scope":"all","readOnly":false,"files":"write","label":"Tom's <tab> & \"pad\"","transport":"lan"}`,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			var warnings bytes.Buffer
			quiet(dir, &warnings).Record(tt.ev)
			got, err := os.ReadFile(Path(dir))
			if err != nil {
				t.Fatal(err)
			}
			if string(got) != tt.want+"\n" {
				t.Fatalf("line\ngot  %s\nwant %s", got, tt.want)
			}
			if warnings.Len() > 0 {
				t.Fatalf("unexpected warning: %s", warnings.String())
			}
		})
	}
}

func TestRecordStampsZeroTime(t *testing.T) {
	dir := t.TempDir()
	before := time.Now().Truncate(time.Millisecond)
	New(dir, nil).Record(Event{Kind: Connected, Transport: Loopback})
	after := time.Now()
	events, err := Read(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("got %d events, want 1", len(events))
	}
	if at := events[0].At; at.Before(before) || at.After(after) {
		t.Fatalf("At = %v, want between %v and %v", at, before, after)
	}
}

func TestRecordAndReadBack(t *testing.T) {
	t.Run("appends NDJSON at 0600 and reads it back in order", func(t *testing.T) {
		// Not created yet, so Record makes it.
		dir := filepath.Join(t.TempDir(), "config", "tmuxde")
		var warnings bytes.Buffer
		log := quiet(dir, &warnings)
		want := []Event{
			{At: t0, Kind: Connected, Label: "iPhone", Transport: LAN},
			{At: t0.Add(time.Minute), Kind: Disconnected, Label: "iPhone", Transport: LAN, Seconds: 60},
		}
		for _, ev := range want {
			log.Record(ev)
		}
		if warnings.Len() > 0 {
			t.Fatalf("unexpected warning: %s", warnings.String())
		}

		got, err := Read(dir)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != len(want) {
			t.Fatalf("got %d events, want %d: %+v", len(got), len(want), got)
		}
		for i := range want {
			if !got[i].At.Equal(want[i].At) {
				t.Errorf("event %d: At = %v, want %v", i, got[i].At, want[i].At)
			}
			got[i].At, want[i].At = time.Time{}, time.Time{}
			if got[i] != want[i] {
				t.Errorf("event %d: got %+v, want %+v", i, got[i], want[i])
			}
		}

		if m := mode(t, Path(dir)); m != 0o600 {
			t.Errorf("log mode = %o, want 600", m)
		}
		if m := mode(t, dir); m != 0o700 {
			t.Errorf("dir mode = %o, want 700", m)
		}
	})

	t.Run("tightens an existing log to 0600", func(t *testing.T) {
		dir := t.TempDir()
		if err := os.WriteFile(Path(dir), nil, 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(Path(dir), 0o644); err != nil {
			t.Fatal(err)
		}
		New(dir, nil).Record(Event{At: t0, Kind: Connected, Transport: LAN})
		if m := mode(t, Path(dir)); m != 0o600 {
			t.Errorf("log mode = %o, want 600", m)
		}
	})

	t.Run("returns nothing when the log does not exist yet", func(t *testing.T) {
		for _, dir := range []string{t.TempDir(), filepath.Join(t.TempDir(), "nope")} {
			events, err := Read(dir)
			if err != nil || events != nil {
				t.Errorf("Read(%q) = %v, %v, want nil, nil", dir, events, err)
			}
		}
	})

	t.Run("skips a truncated final line rather than refusing the whole file", func(t *testing.T) {
		dir := t.TempDir()
		raw := strings.Join([]string{
			`{"event":"connected"}`,
			``,
			`   `,
			`null`,
			`"connected"`,
			`{"at":"yesterday","event":"connected"}`,
			`{"event":"disconnected","seconds":"long"}`,
			`{"event":"disc`,
		}, "\n")
		if err := os.WriteFile(Path(dir), []byte(raw), 0o600); err != nil {
			t.Fatal(err)
		}
		events, err := Read(dir)
		if err != nil {
			t.Fatal(err)
		}
		if len(events) != 1 || events[0].Kind != Connected {
			t.Fatalf("got %+v, want one connected event", events)
		}
	})

	t.Run("keeps lines whole under concurrent writers", func(t *testing.T) {
		dir := t.TempDir()
		log := New(dir, nil)
		const n = 64
		var wg sync.WaitGroup
		for i := range n {
			wg.Go(func() {
				log.Record(Event{At: t0, Kind: Disconnected, Transport: LAN, Seconds: i})
			})
		}
		wg.Wait()
		events, err := Read(dir)
		if err != nil {
			t.Fatal(err)
		}
		seen := make(map[int]bool)
		for _, ev := range events {
			seen[ev.Seconds] = true
		}
		if len(events) != n || len(seen) != n {
			t.Fatalf("got %d events with %d distinct, want %d", len(events), len(seen), n)
		}
	})
}

// A full disk must never be able to deny someone their own machine.
func TestRecordNeverPanicsWhenUnwritable(t *testing.T) {
	tests := []struct {
		name  string
		root  bool // the case still fails for root
		setup func(t *testing.T) string
	}{
		{
			name: "read only directory",
			setup: func(t *testing.T) string {
				dir := t.TempDir()
				if err := os.Chmod(dir, 0o500); err != nil {
					t.Fatal(err)
				}
				// Runs before t.TempDir removes it.
				t.Cleanup(func() { os.Chmod(dir, 0o700) })
				return dir
			},
		},
		{
			// A file where the directory has to be. ENOTDIR is the same
			// shape of failure as a read only home or a full disk.
			name: "file in place of the directory",
			root: true,
			setup: func(t *testing.T) string {
				blocker := filepath.Join(t.TempDir(), "blocked")
				if err := os.WriteFile(blocker, []byte("not a directory"), 0o600); err != nil {
					t.Fatal(err)
				}
				return filepath.Join(blocker, "config")
			},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if !tt.root && os.Geteuid() == 0 {
				t.Skip("root ignores directory permissions")
			}
			dir := tt.setup(t)
			var warnings bytes.Buffer
			log := quiet(dir, &warnings)
			for range 3 {
				log.Record(Event{At: t0, Kind: Connected, Transport: Loopback})
			}
			// Once, not per connection.
			if got := strings.Count(warnings.String(), "access log write failed"); got != 1 {
				t.Fatalf("got %d warnings, want 1:\n%s", got, warnings.String())
			}
			if _, err := os.Stat(Path(dir)); err == nil {
				t.Fatal("log exists, want none")
			}
		})
	}
}

func TestNilLoggerRecordsNothing(t *testing.T) {
	var log *Logger
	log.Record(Event{At: t0, Kind: Connected, Transport: Loopback})
}
