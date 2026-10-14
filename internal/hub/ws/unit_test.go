package ws

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"

	"tmuxde/internal/protocol/server"
)

func TestClientAddr(t *testing.T) {
	unix := &net.UnixAddr{Name: "/run/tmuxde/http.sock", Net: "unix"}
	tcp := &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 24200}
	tests := []struct {
		name   string
		local  net.Addr
		remote string
		xff    []string
		want   string
	}{
		{"loopback peer", tcp, "127.0.0.1:5000", nil, "127.0.0.1"},
		{"loopback peer forwards", tcp, "127.0.0.1:5000", []string{"192.0.2.7, 10.0.0.1"}, "192.0.2.7"},
		{"ipv6 loopback forwards", tcp, "[::1]:5000", []string{"2001:db8::7"}, "2001:db8::7"},
		{"mapped loopback forwards", tcp, "[::ffff:127.0.0.1]:5000", []string{"192.0.2.7"}, "192.0.2.7"},
		{"first header only", tcp, "127.0.0.1:5000", []string{"192.0.2.7", "192.0.2.8"}, "192.0.2.7"},
		{"forwarded with port", tcp, "127.0.0.1:5000", []string{"192.0.2.7:443"}, "192.0.2.7"},
		{"forwarded bracketed v6", tcp, "127.0.0.1:5000", []string{"[2001:db8::7]"}, "2001:db8::7"},
		{"forwarded garbage ignored", tcp, "127.0.0.1:5000", []string{"nonsense"}, "127.0.0.1"},
		{"forwarded empty ignored", tcp, "127.0.0.1:5000", []string{""}, "127.0.0.1"},
		// A LAN peer could forge the header. Its own address counts.
		{"lan peer ignored", tcp, "192.168.1.9:5000", []string{"10.0.0.1"}, "192.168.1.9"},
		{"lan peer", tcp, "192.168.1.9:5000", nil, "192.168.1.9"},
		{"unix forwards", unix, "@", []string{"192.0.2.9"}, "192.0.2.9"},
		{"unix without header", unix, "@", nil, ""},
		{"unix garbage header", unix, "", []string{"nonsense"}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, Path, nil)
			r.RemoteAddr = tt.remote
			for _, v := range tt.xff {
				r.Header.Add("X-Forwarded-For", v)
			}
			r = r.WithContext(context.WithValue(r.Context(), http.LocalAddrContextKey, tt.local))
			if got := clientAddr(r); got != tt.want {
				t.Fatalf("clientAddr = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestRateLimiter(t *testing.T) {
	t0 := time.Date(2026, 10, 12, 9, 0, 0, 0, time.UTC)
	r := rateLimiter{limit: 3, window: time.Second, start: t0}
	steps := []struct {
		at   time.Duration
		want bool
	}{
		{0, true},
		{100 * time.Millisecond, true},
		{200 * time.Millisecond, true},
		{300 * time.Millisecond, false},
		// Refused frames count too, as count++ came first in the relay.
		{999 * time.Millisecond, false},
		// A new window starts at the first frame after the old one ends,
		// not on a fixed grid.
		{1500 * time.Millisecond, true},
		{2400 * time.Millisecond, true},
		{2450 * time.Millisecond, true},
		{2490 * time.Millisecond, false},
		{2500 * time.Millisecond, true},
	}
	for i, s := range steps {
		if got := r.allow(t0.Add(s.at)); got != s.want {
			t.Fatalf("step %d at %v: allow = %v, want %v", i, s.at, got, s.want)
		}
	}
}

func TestSink(t *testing.T) {
	newTestSocket := func() *socket {
		return &socket{out: make(chan frame, 1), done: make(chan struct{})}
	}
	ok := &server.Pong{Type: "pong", Timestamp: 1}

	t.Run("queues encoded messages", func(t *testing.T) {
		k := newTestSocket()
		if err := (sink{k}).Send(context.Background(), ok); err != nil {
			t.Fatal(err)
		}
		f := <-k.out
		if string(f.data) != `{"type":"pong","timestamp":1}` || f.wireType != "pong" {
			t.Fatalf("frame %q %q", f.data, f.wireType)
		}
	})

	t.Run("refuses a message the browser would reject", func(t *testing.T) {
		k := newTestSocket()
		if err := (sink{k}).Send(context.Background(), &server.Pong{Type: "nope"}); err == nil {
			t.Fatal("invalid message queued")
		}
		if err := (sink{k}).Send(context.Background(), nil); err == nil {
			t.Fatal("nil message queued")
		}
		if len(k.out) != 0 {
			t.Fatal("queue not empty")
		}
	})

	t.Run("blocks while full until ctx ends", func(t *testing.T) {
		k := newTestSocket()
		s := sink{k}
		if err := s.Send(context.Background(), ok); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithCancel(context.Background())
		errs := make(chan error, 1)
		go func() { errs <- s.Send(ctx, ok) }()
		select {
		case err := <-errs:
			t.Fatalf("Send returned %v on a full queue", err)
		case <-time.After(20 * time.Millisecond):
		}
		cancel()
		if err := <-errs; !errors.Is(err, context.Canceled) {
			t.Fatalf("Send = %v, want context.Canceled", err)
		}
	})

	t.Run("wakes blocked senders on stop", func(t *testing.T) {
		k := newTestSocket()
		s := sink{k}
		if err := s.Send(context.Background(), ok); err != nil {
			t.Fatal(err)
		}
		errs := make(chan error, 1)
		go func() { errs <- s.Send(context.Background(), ok) }()
		k.stop()
		if err := <-errs; !errors.Is(err, ErrClosed) {
			t.Fatalf("Send = %v, want ErrClosed", err)
		}
	})

	t.Run("refuses after stop even with room", func(t *testing.T) {
		k := newTestSocket()
		k.stop()
		k.stop()
		if err := (sink{k}).Send(context.Background(), ok); !errors.Is(err, ErrClosed) {
			t.Fatalf("Send = %v, want ErrClosed", err)
		}
	})
}

func TestFeatures(t *testing.T) {
	base := []string{"repo:request", "repo:history", "file:upload:ack", "window:step", "pane:step", "repo:watch", "repo:graph"}
	if got := Features(false); !slices.Equal(got, base) {
		t.Fatalf("Features(false) = %v", got)
	}
	got := Features(true)
	if !slices.Equal(got, append(slices.Clone(base), "dictation")) {
		t.Fatalf("Features(true) = %v", got)
	}
	// Callers get their own copy.
	got[0] = "changed"
	if Features(false)[0] != "repo:request" {
		t.Fatal("Features shares its backing array")
	}
}

func TestDefaultPath(t *testing.T) {
	tests := []struct {
		allowed []string
		home    string
		want    string
	}{
		{[]string{"/srv/work", "/home/dev"}, "/home/dev", "/srv/work"},
		{[]string{"/srv/work/"}, "", "/srv/work"},
		{[]string{"/srv/../srv/./work"}, "", "/srv/work"},
		{nil, "/home/dev", "/home/dev"},
		{nil, "", "/"},
	}
	for _, tt := range tests {
		if got := DefaultPath(tt.allowed, tt.home); got != tt.want {
			t.Errorf("DefaultPath(%q, %q) = %q, want %q", tt.allowed, tt.home, got, tt.want)
		}
	}
}

func TestUptime(t *testing.T) {
	tests := []struct {
		in   string
		want float64
	}{
		{"12345.67 54321.00\n", 12345.67},
		{"0.5 1.0", 0.5},
		{"", 0},
		{"abc 1", 0},
		{"-3 1", 0},
	}
	for _, tt := range tests {
		if got := parseUptime([]byte(tt.in)); got != tt.want {
			t.Errorf("parseUptime(%q) = %v, want %v", tt.in, got, tt.want)
		}
	}
	if got := systemUptime(); got <= 0 {
		t.Errorf("systemUptime = %v, want the uptime from %s", got, uptimeFile)
	}
}
