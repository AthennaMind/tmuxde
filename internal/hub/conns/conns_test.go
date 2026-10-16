package conns

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"tmuxde/internal/protocol/server"
)

// t0 is the fake clock start, the relay tests' T0.
var t0 = time.UnixMilli(1_700_000_000_000)

// fakeClock is a settable clock for connect and activity times.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.now = c.now.Add(d)
	c.mu.Unlock()
}

// logBuffer collects log output. slog handlers write from any goroutine.
type logBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *logBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *logBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// inbox records what a connection was sent.
type inbox struct {
	mu   sync.Mutex
	msgs []server.Message
	err  error
}

func (b *inbox) send(msg server.Message) error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.err != nil {
		return b.err
	}
	b.msgs = append(b.msgs, msg)
	return nil
}

func (b *inbox) got() []server.Message {
	b.mu.Lock()
	defer b.mu.Unlock()
	return slices.Clone(b.msgs)
}

// closeRecord is one call of a closer.
type closeRecord struct {
	code   int
	reason string
}

// closes records the calls of a closer.
type closes struct {
	mu   sync.Mutex
	list []closeRecord
}

func (c *closes) closer(code int, reason string) {
	c.mu.Lock()
	c.list = append(c.list, closeRecord{code, reason})
	c.mu.Unlock()
}

func (c *closes) got() []closeRecord {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.list)
}

type testEnv struct {
	reg   *Registry
	clock *fakeClock
	logs  *logBuffer
}

func newEnv(t *testing.T) *testEnv {
	t.Helper()
	clock := &fakeClock{now: t0}
	logs := &logBuffer{}
	reg := New(Options{
		Logger: slog.New(slog.NewTextHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug})),
		Now:    clock.Now,
	})
	return &testEnv{reg: reg, clock: clock, logs: logs}
}

// add registers a connection from addr and returns it with its inbox.
func (e *testEnv) add(t *testing.T, addr string) (*Conn, *inbox) {
	t.Helper()
	box := &inbox{}
	c, err := e.reg.Add(addr, "", box.send)
	if err != nil {
		t.Fatalf("Add(%q): %v", addr, err)
	}
	return c, box
}

// authed registers an authenticated connection from addr.
func (e *testEnv) authed(t *testing.T, addr, label string) (*Conn, *inbox) {
	t.Helper()
	c, box := e.add(t, addr)
	if !c.Authenticate(label) {
		t.Fatalf("Authenticate(%q) on %s refused", label, c.ID())
	}
	return c, box
}

func killed(name string) server.Message {
	return &server.SessionKilled{Type: "session:killed", Name: name}
}

func killedFor(name string) func(*Conn) (server.Message, error) {
	return func(*Conn) (server.Message, error) { return killed(name), nil }
}

func noSend(server.Message) error { return nil }

func ids(list []*Conn) []string {
	out := []string{}
	for _, c := range list {
		out = append(out, c.ID())
	}
	return out
}

func infoIDs(list []Info) []string {
	out := []string{}
	for _, i := range list {
		out = append(out, i.ID)
	}
	return out
}

func TestAdd(t *testing.T) {
	t.Run("assigns monotonic ids that are never reused", func(t *testing.T) {
		e := newEnv(t)
		a, _ := e.add(t, "10.0.0.1")
		b, _ := e.add(t, "10.0.0.1")
		if !e.reg.Remove(a.ID()) {
			t.Fatal("Remove(a) = false")
		}
		c, _ := e.add(t, "10.0.0.1")
		got := []string{a.ID(), b.ID(), c.ID()}
		if want := []string{"conn-1", "conn-2", "conn-3"}; !slices.Equal(got, want) {
			t.Fatalf("ids = %v, want %v", got, want)
		}
		if a.Seq() != 1 || b.Seq() != 2 || c.Seq() != 3 {
			t.Fatalf("seqs = %d %d %d, want 1 2 3", a.Seq(), b.Seq(), c.Seq())
		}
	})

	t.Run("records address, user agent and times", func(t *testing.T) {
		e := newEnv(t)
		c, err := e.reg.Add("192.168.1.50", "Mozilla/5.0", noSend)
		if err != nil {
			t.Fatal(err)
		}
		if c.RemoteAddr() != "192.168.1.50" || c.UserAgent() != "Mozilla/5.0" {
			t.Fatalf("addr %q ua %q", c.RemoteAddr(), c.UserAgent())
		}
		if !c.ConnectedAt().Equal(t0) || !c.LastActivity().Equal(t0) {
			t.Fatalf("connectedAt %v lastActivity %v, want both %v", c.ConnectedAt(), c.LastActivity(), t0)
		}
		if c.Authenticated() || c.Label() != "" || c.AttachedSession() != "" || c.Closing() {
			t.Fatal("new connection is not blank")
		}
		if got, ok := e.reg.Get(c.ID()); !ok || got != c {
			t.Fatalf("Get(%q) = %v, %v", c.ID(), got, ok)
		}
	})

	t.Run("counts an empty address as unknown", func(t *testing.T) {
		e := newEnv(t)
		a, _ := e.add(t, "")
		e.add(t, "")
		if a.RemoteAddr() != UnknownAddr {
			t.Fatalf("RemoteAddr() = %q, want %q", a.RemoteAddr(), UnknownAddr)
		}
		if n := e.reg.CountByAddr(UnknownAddr); n != 2 {
			t.Fatalf("CountByAddr(unknown) = %d, want 2", n)
		}
		if n := e.reg.CountByAddr(""); n != 2 {
			t.Fatalf("CountByAddr(\"\") = %d, want 2", n)
		}
	})

	t.Run("keys on the raw address", func(t *testing.T) {
		e := newEnv(t)
		e.add(t, "::ffff:10.0.0.1")
		e.add(t, "10.0.0.1")
		e.add(t, "10.0.0.1")
		if n := e.reg.CountByAddr("::ffff:10.0.0.1"); n != 1 {
			t.Fatalf("mapped count = %d, want 1", n)
		}
		if n := e.reg.CountByAddr("10.0.0.1"); n != 2 {
			t.Fatalf("plain count = %d, want 2", n)
		}
	})

	t.Run("refuses a nil send", func(t *testing.T) {
		e := newEnv(t)
		if _, err := e.reg.Add("10.0.0.1", "", nil); err == nil {
			t.Fatal("Add with nil send succeeded")
		}
		if n := e.reg.Count(); n != 0 {
			t.Fatalf("Count() = %d, want 0", n)
		}
	})
}

func TestCaps(t *testing.T) {
	// fill opens MaxConns connections, MaxConnsPerAddr from each of
	// MaxConns/MaxConnsPerAddr addresses, 10.0.0.0 upwards.
	fill := func(t *testing.T, e *testEnv) {
		t.Helper()
		for i := range MaxConns {
			e.add(t, fmt.Sprintf("10.0.0.%d", i/MaxConnsPerAddr))
		}
	}
	tests := []struct {
		name  string
		setup func(t *testing.T, e *testEnv)
		addr  string
		want  error
	}{
		{"refuses the connection past MaxConns as server full", fill, "10.0.1.1", ErrServerFull},
		{"checks the global cap before the address cap", fill, "10.0.0.0", ErrServerFull},
		{
			"refuses the connection past MaxConnsPerAddr from one address",
			func(t *testing.T, e *testEnv) {
				for range MaxConnsPerAddr {
					e.add(t, "10.0.0.1")
				}
			},
			"10.0.0.1", ErrAddressFull,
		},
		{
			"counts unknown addresses against one shared cap",
			func(t *testing.T, e *testEnv) {
				for range MaxConnsPerAddr {
					e.add(t, "")
				}
			},
			UnknownAddr, ErrAddressFull,
		},
		{
			"counts unauthenticated connections toward the address cap",
			func(t *testing.T, e *testEnv) {
				for range MaxConnsPerAddr - 1 {
					e.add(t, "10.0.0.1")
				}
				e.authed(t, "10.0.0.1", "")
			},
			"10.0.0.1", ErrAddressFull,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			tt.setup(t, e)
			before := e.reg.Count()
			c, err := e.reg.Add(tt.addr, "", noSend)
			if !errors.Is(err, tt.want) || c != nil {
				t.Fatalf("Add(%q) = %v, %v, want nil, %v", tt.addr, c, err, tt.want)
			}
			if n := e.reg.Count(); n != before {
				t.Fatalf("Count() = %d after refusal, want %d", n, before)
			}
		})
	}

	t.Run("options override both caps", func(t *testing.T) {
		tests := []struct {
			name          string
			global, perIP int
			addrs         []string
			next          string
			want          error
		}{
			{"global", 2, 0, []string{"10.0.0.1", "10.0.0.2"}, "10.0.0.3", ErrServerFull},
			{"per address", 0, 1, []string{"10.0.0.1"}, "10.0.0.1", ErrAddressFull},
			{"per address leaves others", 0, 1, []string{"10.0.0.1"}, "10.0.0.2", nil},
		}
		for _, tt := range tests {
			t.Run(tt.name, func(t *testing.T) {
				reg := New(Options{
					Logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
					MaxConns:        tt.global,
					MaxConnsPerAddr: tt.perIP,
				})
				for _, a := range tt.addrs {
					if _, err := reg.Add(a, "", noSend); err != nil {
						t.Fatalf("Add(%q): %v", a, err)
					}
				}
				if _, err := reg.Add(tt.next, "", noSend); !errors.Is(err, tt.want) {
					t.Fatalf("Add(%q) = %v, want %v", tt.next, err, tt.want)
				}
			})
		}
	})

	t.Run("refusal uses no id and remove frees a slot", func(t *testing.T) {
		e := newEnv(t)
		fill(t, e)
		if _, err := e.reg.Add("10.0.1.1", "", noSend); !errors.Is(err, ErrServerFull) {
			t.Fatalf("Add = %v, want ErrServerFull", err)
		}
		if !e.reg.Remove("conn-1") {
			t.Fatal("Remove(conn-1) = false")
		}
		if n := e.reg.CountByAddr("10.0.0.0"); n != MaxConnsPerAddr-1 {
			t.Fatalf("CountByAddr = %d, want %d", n, MaxConnsPerAddr-1)
		}
		c, _ := e.add(t, "10.0.0.0")
		if want := fmt.Sprintf("conn-%d", MaxConns+1); c.ID() != want {
			t.Fatalf("next id = %q, want %s", c.ID(), want)
		}
	})

	t.Run("drops an address once its last connection goes", func(t *testing.T) {
		e := newEnv(t)
		a, _ := e.add(t, "10.0.0.1")
		e.reg.Remove(a.ID())
		if n := e.reg.CountByAddr("10.0.0.1"); n != 0 {
			t.Fatalf("CountByAddr = %d, want 0", n)
		}
		if len(e.reg.perAddr) != 0 {
			t.Fatalf("perAddr = %v, want empty", e.reg.perAddr)
		}
	})
}

// TestBroadcastWhere ports the relay's "scoped broadcasts". Scopes are
// gone, so the scope test became a predicate test.
func TestBroadcastWhere(t *testing.T) {
	t.Run("delivers only where the predicate holds", func(t *testing.T) {
		e := newEnv(t)
		a, inboxA := e.authed(t, "10.0.0.1", "")
		a.SetAttachedSession("work")
		b, inboxB := e.authed(t, "10.0.0.2", "")
		b.SetAttachedSession("other")

		n := e.reg.BroadcastWhere(
			func(c *Conn) bool { return c.AttachedSession() == "work" },
			killedFor("work"), nil)

		if n != 1 || len(inboxA.got()) != 1 || len(inboxB.got()) != 0 {
			t.Fatalf("sent %d, a got %v, b got %v", n, inboxA.got(), inboxB.got())
		}
	})

	t.Run("skips connections that have not authenticated", func(t *testing.T) {
		e := newEnv(t)
		_, inbox := e.add(t, "10.0.0.3")
		if n := e.reg.Broadcast(killed("work"), nil); n != 0 {
			t.Fatalf("sent %d, want 0", n)
		}
		if got := inbox.got(); len(got) != 0 {
			t.Fatalf("unauthenticated connection got %v", got)
		}
	})

	t.Run("honours the exclusion, so an actor is not told its own news twice", func(t *testing.T) {
		e := newEnv(t)
		a, inboxA := e.authed(t, "10.0.0.4", "")
		_, inboxB := e.authed(t, "10.0.0.5", "")

		e.reg.Broadcast(killed("work"), a)

		if len(inboxA.got()) != 0 || len(inboxB.got()) != 1 {
			t.Fatalf("a got %v, b got %v", inboxA.got(), inboxB.got())
		}
	})

	builders := []struct {
		name string
		fail func() (server.Message, error)
	}{
		{"keeps delivering when one connection's builder fails", func() (server.Message, error) {
			return nil, errors.New("builder blew up")
		}},
		{"keeps delivering when one connection's builder panics", func() (server.Message, error) {
			panic("builder blew up")
		}},
	}
	for _, tt := range builders {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			a, inboxA := e.authed(t, "10.0.0.6", "")
			_, inboxB := e.authed(t, "10.0.0.7", "")

			n := e.reg.BroadcastWhere(nil, func(c *Conn) (server.Message, error) {
				if c == a {
					return tt.fail()
				}
				return killed("work"), nil
			}, nil)

			if n != 1 || len(inboxA.got()) != 0 || len(inboxB.got()) != 1 {
				t.Fatalf("sent %d, a got %v, b got %v", n, inboxA.got(), inboxB.got())
			}
			logs := e.logs.String()
			if !strings.Contains(logs, "broadcast build failed") || !strings.Contains(logs, "builder blew up") || !strings.Contains(logs, a.ID()) {
				t.Fatalf("failure not logged: %s", logs)
			}
		})
	}

	t.Run("gives a full grant every session event", func(t *testing.T) {
		// The only grant left. It sees every session, so a broadcast with
		// no predicate reaches it.
		e := newEnv(t)
		_, inbox := e.authed(t, "10.0.0.8", "")
		if n := e.reg.Broadcast(killed("anything-at-all"), nil); n != 1 || len(inbox.got()) != 1 {
			t.Fatalf("sent %d, got %v", n, inbox.got())
		}
	})

	t.Run("skips a connection whose builder returns nil", func(t *testing.T) {
		e := newEnv(t)
		_, inbox := e.authed(t, "10.0.0.9", "")
		n := e.reg.BroadcastWhere(nil, func(*Conn) (server.Message, error) { return nil, nil }, nil)
		if n != 0 || len(inbox.got()) != 0 {
			t.Fatalf("sent %d, got %v", n, inbox.got())
		}
	})

	t.Run("keeps delivering when one send fails", func(t *testing.T) {
		e := newEnv(t)
		_, inboxA := e.authed(t, "10.0.0.10", "")
		inboxA.err = errors.New("socket gone")
		_, inboxB := e.authed(t, "10.0.0.11", "")
		if n := e.reg.Broadcast(killed("work"), nil); n != 1 || len(inboxB.got()) != 1 {
			t.Fatalf("sent %d, b got %v", n, inboxB.got())
		}
	})

	t.Run("does not let a stalled send hold up the others", func(t *testing.T) {
		// conn-1 stands for a browser whose queue is full. Its send blocks
		// until released. conn-2 must get the message before that.
		e := newEnv(t)
		release := make(chan struct{})
		stalled, err := e.reg.Add("10.0.0.12", "", func(server.Message) error {
			<-release
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		stalled.Authenticate("")
		reached := make(chan struct{})
		healthy, err := e.reg.Add("10.0.0.13", "", func(server.Message) error {
			close(reached)
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
		healthy.Authenticate("")

		done := make(chan int, 1)
		go func() { done <- e.reg.Broadcast(killed("work"), nil) }()

		select {
		case <-reached:
		case <-time.After(5 * time.Second):
			close(release)
			t.Fatal("healthy connection waited for the stalled one")
		}
		select {
		case n := <-done:
			t.Fatalf("broadcast returned %d before the stalled send ended", n)
		default:
		}
		close(release)
		if n := <-done; n != 2 {
			t.Fatalf("sent %d, want 2", n)
		}
	})

	t.Run("delivers in id order", func(t *testing.T) {
		e := newEnv(t)
		var mu sync.Mutex
		var order []string
		for i := range 20 {
			c, err := e.reg.Add(fmt.Sprintf("10.0.%d.1", i), "", func(server.Message) error { return nil })
			if err != nil {
				t.Fatal(err)
			}
			c.Authenticate("")
		}
		e.reg.BroadcastWhere(nil, func(c *Conn) (server.Message, error) {
			mu.Lock()
			order = append(order, c.ID())
			mu.Unlock()
			return killed("work"), nil
		}, nil)
		if want := ids(e.reg.All()); !slices.Equal(order, want) {
			t.Fatalf("order = %v, want %v", order, want)
		}
	})
}

// TestSummary ports the relay's "connectionSummary". The read only, scope
// and control boundary tests went with scoped grants and the CLI.
func TestSummary(t *testing.T) {
	t.Run("is empty before anything authenticates", func(t *testing.T) {
		e := newEnv(t)
		if got := e.reg.Summary(); got == nil || len(got) != 0 {
			t.Fatalf("Summary() = %#v, want empty", got)
		}
		e.add(t, "10.0.0.1")
		if got := e.reg.Summary(); len(got) != 0 {
			t.Fatalf("Summary() = %v, want empty", got)
		}
	})

	t.Run("counts authenticated connections only", func(t *testing.T) {
		// A socket that opened but proved nothing is not a device the user
		// admitted. Counting it would make the number twitch at every port
		// scan.
		e := newEnv(t)
		e.add(t, "10.0.0.1")
		e.authed(t, "10.0.0.2", "iPhone \u00b7 Safari")
		got := e.reg.Summary()
		if len(got) != 1 || got[0].Label != "iPhone \u00b7 Safari" {
			t.Fatalf("Summary() = %v", got)
		}
	})

	t.Run("falls back to a neutral label rather than naming nothing", func(t *testing.T) {
		e := newEnv(t)
		c, _ := e.authed(t, "10.0.0.1", "")
		got := e.reg.Summary()
		if len(got) != 1 || got[0].Label != FallbackLabel || FallbackLabel != "A device" {
			t.Fatalf("Summary() = %v, want label %q", got, "A device")
		}
		if c.Label() != "" {
			t.Fatalf("Label() = %q, want the stored empty string", c.Label())
		}
	})

	t.Run("gives an in-process caller the address and session", func(t *testing.T) {
		e := newEnv(t)
		c, _ := e.authed(t, "192.168.1.50", "iPhone")
		c.SetAttachedSession("secret-project")
		want := []Info{{
			ID:              c.ID(),
			Label:           "iPhone",
			RemoteAddr:      "192.168.1.50",
			AttachedSession: "secret-project",
			ConnectedAt:     t0,
		}}
		if got := e.reg.Summary(); !slices.Equal(got, want) {
			t.Fatalf("Summary() = %v, want %v", got, want)
		}
	})

	t.Run("orders oldest first, so the list does not reshuffle on every render", func(t *testing.T) {
		// Twenty connections make a map order pass by luck unlikely. Pairs
		// share a connect time, so ties must keep id order.
		e := newEnv(t)
		var want []string
		for i := range 20 {
			c, _ := e.authed(t, fmt.Sprintf("10.0.%d.1", i), fmt.Sprintf("device %d", i))
			want = append(want, c.ID())
			if i%2 == 1 {
				e.clock.Advance(time.Second)
			}
		}
		got := e.reg.Summary()
		if !slices.Equal(infoIDs(got), want) {
			t.Fatalf("order = %v, want %v", infoIDs(got), want)
		}
		if got[0].Label != "device 0" || got[19].Label != "device 19" {
			t.Fatalf("labels = %q ... %q", got[0].Label, got[19].Label)
		}
	})
}

// TestOnChanged ports the relay's "onConnectionsChanged".
func TestOnChanged(t *testing.T) {
	t.Run("notifies subscribers and stops after unsubscribe", func(t *testing.T) {
		e := newEnv(t)
		fired := 0
		off := e.reg.OnChanged(func() { fired++ })
		e.reg.notifyChanged()
		if fired != 1 {
			t.Fatalf("fired %d, want 1", fired)
		}
		off()
		off()
		e.reg.notifyChanged()
		if fired != 1 {
			t.Fatalf("fired %d after unsubscribe, want 1", fired)
		}
	})

	t.Run("survives a listener that panics", func(t *testing.T) {
		// A broken display must never be able to take down a connection.
		e := newEnv(t)
		off1 := e.reg.OnChanged(func() { panic("boom") })
		reached := false
		off2 := e.reg.OnChanged(func() { reached = true })
		defer off1()
		defer off2()

		c, _ := e.add(t, "10.0.0.1")
		if !c.Authenticate("") {
			t.Fatal("Authenticate refused")
		}
		if !reached {
			t.Fatal("second listener not reached")
		}
		if logs := e.logs.String(); !strings.Contains(logs, "connections listener panicked") || !strings.Contains(logs, "boom") {
			t.Fatalf("panic not logged: %s", logs)
		}
	})

	t.Run("fires on authentication and on removing an authenticated connection", func(t *testing.T) {
		e := newEnv(t)
		fired := 0
		defer e.reg.OnChanged(func() { fired++ })()

		quiet, _ := e.add(t, "10.0.0.1")
		c, _ := e.add(t, "10.0.0.2")
		if fired != 0 {
			t.Fatalf("Add fired %d", fired)
		}
		c.Authenticate("")
		if fired != 1 {
			t.Fatalf("Authenticate fired %d, want 1", fired)
		}
		if c.Authenticate("again") {
			t.Fatal("second Authenticate accepted")
		}
		e.reg.Remove(quiet.ID())
		if fired != 1 {
			t.Fatalf("removing an unauthenticated connection fired, total %d", fired)
		}
		e.reg.Remove(c.ID())
		if fired != 2 {
			t.Fatalf("Remove fired %d in total, want 2", fired)
		}
	})

	t.Run("lets a listener read the registry", func(t *testing.T) {
		e := newEnv(t)
		var seen []int
		defer e.reg.OnChanged(func() { seen = append(seen, len(e.reg.Summary())) })()
		c, _ := e.authed(t, "10.0.0.1", "")
		e.reg.Remove(c.ID())
		if !slices.Equal(seen, []int{1, 0}) {
			t.Fatalf("listener saw %v, want [1 0]", seen)
		}
	})
}

// TestDisconnect ports the relay's "disconnectConnection".
func TestDisconnect(t *testing.T) {
	t.Run("closes the socket and drops it from the list", func(t *testing.T) {
		e := newEnv(t)
		c, _ := e.authed(t, "10.0.0.1", "iPhone")
		var cl closes
		c.SetCloser(cl.closer)
		hooked := false
		c.OnClose(func() { hooked = true })

		if !e.reg.Disconnect(c.ID()) {
			t.Fatal("Disconnect = false")
		}
		if got := cl.got(); !slices.Equal(got, []closeRecord{{1000, "Closed from the machine"}}) {
			t.Fatalf("closes = %v", got)
		}
		if got := e.reg.Summary(); len(got) != 0 {
			t.Fatalf("Summary() = %v, want empty", got)
		}
		if _, ok := e.reg.Get(c.ID()); ok || e.reg.Count() != 0 || !hooked {
			t.Fatalf("still registered or hooks not run: count %d hooked %v", e.reg.Count(), hooked)
		}
	})

	t.Run("closes exactly the socket named", func(t *testing.T) {
		// Two tabs on one phone come from one address with one label.
		// Closing one has to mean that one.
		e := newEnv(t)
		a, _ := e.authed(t, "10.0.0.1", "iPhone")
		b, _ := e.authed(t, "10.0.0.1", "iPhone")
		var closesA, closesB closes
		a.SetCloser(closesA.closer)
		b.SetCloser(closesB.closer)

		e.reg.Disconnect(a.ID())

		if len(closesA.got()) != 1 || len(closesB.got()) != 0 {
			t.Fatalf("a closes %v, b closes %v", closesA.got(), closesB.got())
		}
		if got := infoIDs(e.reg.Summary()); !slices.Equal(got, []string{b.ID()}) {
			t.Fatalf("left %v, want [%s]", got, b.ID())
		}
		if n := e.reg.CountByAddr("10.0.0.1"); n != 1 {
			t.Fatalf("CountByAddr = %d, want 1", n)
		}
	})

	t.Run("reports false for an unknown id", func(t *testing.T) {
		// The caller races the list against the socket closing on its own.
		// Losing that race is ordinary.
		e := newEnv(t)
		if e.reg.Disconnect("gone") {
			t.Fatal("Disconnect(gone) = true")
		}
		c, _ := e.add(t, "10.0.0.1")
		e.reg.Disconnect(c.ID())
		if e.reg.Disconnect(c.ID()) {
			t.Fatal("second Disconnect = true")
		}
	})

	t.Run("removes a connection that has no closer yet", func(t *testing.T) {
		e := newEnv(t)
		c, _ := e.add(t, "10.0.0.1")
		if !e.reg.Disconnect(c.ID()) || e.reg.Count() != 0 {
			t.Fatalf("Disconnect without closer left count %d", e.reg.Count())
		}
	})

	t.Run("survives a closer that panics", func(t *testing.T) {
		e := newEnv(t)
		c, _ := e.add(t, "10.0.0.1")
		c.SetCloser(func(int, string) { panic("closer blew up") })
		if !e.reg.Disconnect(c.ID()) || e.reg.Count() != 0 {
			t.Fatal("panicking closer stopped the removal")
		}
		if logs := e.logs.String(); !strings.Contains(logs, "closer panicked") {
			t.Fatalf("panic not logged: %s", logs)
		}
	})
}

func TestRemove(t *testing.T) {
	t.Run("runs close hooks once and in order", func(t *testing.T) {
		e := newEnv(t)
		c, _ := e.add(t, "10.0.0.1")
		var order []string
		for _, name := range []string{"dictation", "pty", "watchers", "uploads"} {
			c.OnClose(func() { order = append(order, name) })
		}
		if !e.reg.Remove(c.ID()) {
			t.Fatal("Remove = false")
		}
		if e.reg.Remove(c.ID()) {
			t.Fatal("second Remove = true")
		}
		if want := []string{"dictation", "pty", "watchers", "uploads"}; !slices.Equal(order, want) {
			t.Fatalf("hooks ran %v, want %v", order, want)
		}
	})

	t.Run("keeps running hooks after one panics", func(t *testing.T) {
		e := newEnv(t)
		c, _ := e.add(t, "10.0.0.1")
		ran := false
		c.OnClose(func() { panic("hook blew up") })
		c.OnClose(func() { ran = true })
		e.reg.Remove(c.ID())
		if !ran {
			t.Fatal("hook after the panicking one did not run")
		}
		if logs := e.logs.String(); !strings.Contains(logs, "close hook panicked") || !strings.Contains(logs, "hook blew up") {
			t.Fatalf("panic not logged: %s", logs)
		}
	})

	t.Run("runs a hook added after removal at once", func(t *testing.T) {
		e := newEnv(t)
		c, _ := e.add(t, "10.0.0.1")
		e.reg.Remove(c.ID())
		ran := false
		c.OnClose(func() { ran = true })
		if !ran {
			t.Fatal("late hook did not run")
		}
	})

	t.Run("ends the connection", func(t *testing.T) {
		e := newEnv(t)
		c, box := e.authed(t, "10.0.0.1", "")
		e.reg.Remove(c.ID())
		if c.Context().Err() == nil {
			t.Fatal("context not cancelled")
		}
		if !c.Closing() {
			t.Fatal("Closing() = false after Remove")
		}
		if err := c.Send(killed("work")); !errors.Is(err, ErrClosed) {
			t.Fatalf("Send after Remove = %v, want ErrClosed", err)
		}
		if len(box.got()) != 0 {
			t.Fatalf("send function called after Remove: %v", box.got())
		}
		if c.Authenticate("late") {
			t.Fatal("Authenticate after Remove accepted")
		}
		if e.reg.Count() != 0 || e.reg.CountByAddr("10.0.0.1") != 0 {
			t.Fatalf("count %d, by addr %d", e.reg.Count(), e.reg.CountByAddr("10.0.0.1"))
		}
	})
}

func TestSend(t *testing.T) {
	e := newEnv(t)
	c, box := e.add(t, "10.0.0.1")
	if err := c.Send(killed("work")); err != nil {
		t.Fatal(err)
	}
	if got := box.got(); len(got) != 1 || got[0].WireType() != "session:killed" {
		t.Fatalf("sent %v", got)
	}
	box.err = errors.New("queue full")
	if err := c.Send(killed("work")); err == nil || err.Error() != "queue full" {
		t.Fatalf("Send = %v, want the send function's error", err)
	}
}

func TestClose(t *testing.T) {
	e := newEnv(t)
	c, _ := e.add(t, "10.0.0.1")
	c.Close(1000, "Idle timeout") // no closer yet, nothing happens
	var cl closes
	c.SetCloser(cl.closer)
	c.Close(1001, "Server shutting down")
	if got := cl.got(); !slices.Equal(got, []closeRecord{{1001, "Server shutting down"}}) {
		t.Fatalf("closes = %v", got)
	}
	if e.reg.Count() != 1 {
		t.Fatal("Close removed the connection")
	}
}

func TestAttached(t *testing.T) {
	e := newEnv(t)
	a, _ := e.authed(t, "10.0.0.1", "")
	a.SetAttachedSession("work")
	b, _ := e.authed(t, "10.0.0.2", "")
	b.SetAttachedSession("other")
	c, _ := e.authed(t, "10.0.0.3", "")
	c.SetAttachedSession("work")
	unauthed, _ := e.add(t, "10.0.0.4")
	unauthed.SetAttachedSession("hidden")
	e.authed(t, "10.0.0.5", "")

	tests := []struct {
		session string
		want    []string
	}{
		{"work", []string{a.ID(), c.ID()}},
		{"other", []string{b.ID()}},
		{"hidden", []string{}},
		{"", []string{}},
	}
	for _, tt := range tests {
		if got := ids(e.reg.Attached(tt.session)); !slices.Equal(got, tt.want) {
			t.Errorf("Attached(%q) = %v, want %v", tt.session, got, tt.want)
		}
	}
	if got := e.reg.AttachedSessions(); !slices.Equal(got, []string{"other", "work"}) {
		t.Errorf("AttachedSessions() = %v", got)
	}
	a.SetAttachedSession("")
	if got := ids(e.reg.Attached("work")); !slices.Equal(got, []string{c.ID()}) {
		t.Errorf("after detach Attached(work) = %v", got)
	}
}

func TestIdleCandidates(t *testing.T) {
	const timeout = 30 * time.Minute
	tests := []struct {
		name    string
		idle    time.Duration
		timeout time.Duration
		want    bool
	}{
		{"keeps a fresh connection", 0, timeout, false},
		{"keeps a connection idle for exactly the timeout", timeout, timeout, false},
		{"reaps a connection idle past the timeout", timeout + time.Nanosecond, timeout, true},
		{"never reaps with a zero timeout", 24 * time.Hour, 0, false},
		{"never reaps with a negative timeout", 24 * time.Hour, -time.Minute, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := newEnv(t)
			c, _ := e.add(t, "10.0.0.1")
			want := []string{}
			if tt.want {
				want = []string{c.ID()}
			}
			if got := ids(e.reg.IdleCandidates(t0.Add(tt.idle), tt.timeout)); !slices.Equal(got, want) {
				t.Fatalf("IdleCandidates = %v, want %v", got, want)
			}
		})
	}

	t.Run("measures from the last touch, authenticated or not", func(t *testing.T) {
		e := newEnv(t)
		quiet, _ := e.add(t, "10.0.0.1")
		quietAuthed, _ := e.authed(t, "10.0.0.2", "")
		busy, _ := e.authed(t, "10.0.0.3", "")
		e.clock.Advance(20 * time.Minute)
		busy.Touch()
		if !busy.LastActivity().Equal(t0.Add(20 * time.Minute)) {
			t.Fatalf("LastActivity() = %v", busy.LastActivity())
		}
		got := e.reg.IdleCandidates(t0.Add(31*time.Minute), timeout)
		if want := []string{quiet.ID(), quietAuthed.ID()}; !slices.Equal(ids(got), want) {
			t.Fatalf("IdleCandidates = %v, want %v", ids(got), want)
		}
	})
}

func TestConcurrentUse(t *testing.T) {
	// Run with -race. Every public method from many goroutines at once.
	reg := New(Options{Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	defer reg.OnChanged(func() { reg.Summary() })()

	var wg sync.WaitGroup
	for g := range 16 {
		wg.Go(func() {
			for i := range 50 {
				c, err := reg.Add(fmt.Sprintf("10.0.%d.%d", g, i%3), "ua", noSend)
				if err != nil {
					// Each goroutine holds one slot at most, far below the caps.
					t.Error(err)
					continue
				}
				c.SetCloser(func(int, string) {})
				c.OnClose(func() {})
				c.Touch()
				c.Authenticate(fmt.Sprintf("device %d", g))
				c.SetAttachedSession(fmt.Sprintf("s%d", i%4))
				c.Enqueue(func(ctx context.Context) error {
					reg.BroadcastWhere(func(o *Conn) bool { return o.AttachedSession() == "s1" }, killedFor("s1"), c)
					return nil
				})
				reg.Attached("s1")
				reg.AttachedSessions()
				reg.Summary()
				reg.IdleCandidates(time.Now(), time.Minute)
				reg.CountByAddr(c.RemoteAddr())
				if i%2 == 0 {
					reg.Disconnect(c.ID())
				} else {
					c.SetClosing()
					if err := c.Drain(context.Background()); err != nil {
						t.Error(err)
					}
					reg.Remove(c.ID())
				}
			}
		})
	}
	wg.Wait()
	if n := reg.Count(); n != 0 {
		t.Fatalf("Count() = %d after all removed, want 0", n)
	}
	reg.mu.Lock()
	defer reg.mu.Unlock()
	if len(reg.perAddr) != 0 {
		t.Fatalf("perAddr = %v, want empty", reg.perAddr)
	}
}
