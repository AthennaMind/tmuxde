package auth

import (
	"net/netip"
	"sync"
	"testing"
	"time"
)

// ip and t0 are the address and start time of auth-throttle.test.ts.
const ip = "192.168.1.50"

var t0 = time.UnixMilli(1_700_000_000_000)

// fakeClock is a settable clock. Safe for concurrent reads.
type fakeClock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *fakeClock) Set(now time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = now
}

func newTestThrottle() (*Throttle, *fakeClock) {
	c := &fakeClock{now: t0}
	return NewThrottle(c.Now), c
}

// decision mirrors ThrottleDecision so results compare as one value.
type decision struct {
	allowed    bool
	retryAfter time.Duration
}

var open = decision{allowed: true}

func locked(d time.Duration) decision { return decision{retryAfter: d} }

func check(th *Throttle, addr string) decision {
	allowed, wait := th.Check(addr)
	return decision{allowed, wait}
}

func record(th *Throttle, addr string) decision {
	allowed, wait := th.RecordFailure(addr)
	return decision{allowed, wait}
}

// fail records n failures for addr and returns the last decision.
func fail(th *Throttle, addr string, n int) decision {
	var last decision
	for range n {
		last = record(th, addr)
	}
	return last
}

// auth-throttle.test.ts: "allows attempts from an address it has never seen".
func TestThrottleAllowsUnseenAddress(t *testing.T) {
	th, _ := newTestThrottle()
	if got := check(th, ip); got != open {
		t.Fatalf("Check = %+v, want %+v", got, open)
	}
}

// auth-throttle.test.ts: "allows the first four failures without locking out".
func TestThrottleAllowsFirstFourFailures(t *testing.T) {
	th, _ := newTestThrottle()
	for i := range FailuresBeforeLockout - 1 {
		if got := record(th, ip); got != open {
			t.Fatalf("failure %d: RecordFailure = %+v, want %+v", i+1, got, open)
		}
		if got := check(th, ip); got != open {
			t.Fatalf("failure %d: Check = %+v, want %+v", i+1, got, open)
		}
	}
}

// auth-throttle.test.ts: "locks out for 30s on the fifth failure".
func TestThrottleLocksOutOnFifthFailure(t *testing.T) {
	th, _ := newTestThrottle()
	want := locked(BaseLockout)
	if got := fail(th, ip, FailuresBeforeLockout); got != want {
		t.Fatalf("RecordFailure = %+v, want %+v", got, want)
	}
	if got := check(th, ip); got != want {
		t.Fatalf("Check = %+v, want %+v", got, want)
	}
}

// auth-throttle.test.ts: "lets the address back in once the lockout elapses".
func TestThrottleLetsAddressBackInAfterLockout(t *testing.T) {
	th, clock := newTestThrottle()
	fail(th, ip, FailuresBeforeLockout)
	clock.Set(t0.Add(BaseLockout - time.Millisecond))
	if got := check(th, ip); got.allowed {
		t.Fatalf("Check 1ms before the end = %+v, want locked", got)
	}
	clock.Set(t0.Add(BaseLockout))
	if got := check(th, ip); got != open {
		t.Fatalf("Check at the end = %+v, want %+v", got, open)
	}
}

// auth-throttle.test.ts: "doubles the lockout on each further failure".
func TestThrottleDoublesLockoutOnEachFurtherFailure(t *testing.T) {
	th, clock := newTestThrottle()
	fail(th, ip, FailuresBeforeLockout)
	want := BaseLockout
	for i := range 4 {
		want *= 2
		clock.Set(t0.Add(time.Duration(i+1) * time.Millisecond))
		if got := record(th, ip); got != locked(want) {
			t.Fatalf("further failure %d = %+v, want %+v", i+1, got, locked(want))
		}
	}
}

// auth-throttle.test.ts: "caps the lockout at 15 minutes".
func TestThrottleCapsLockoutAtFifteenMinutes(t *testing.T) {
	th, _ := newTestThrottle()
	fail(th, ip, FailuresBeforeLockout)
	if got := fail(th, ip, 20); got != locked(MaxLockout) {
		t.Fatalf("RecordFailure = %+v, want %+v", got, locked(MaxLockout))
	}
}

// auth-throttle.test.ts: "clears the whole history on a success".
func TestThrottleSuccessClearsHistory(t *testing.T) {
	th, _ := newTestThrottle()
	fail(th, ip, FailuresBeforeLockout)
	if got := check(th, ip); got.allowed {
		t.Fatalf("Check before success = %+v, want locked", got)
	}
	th.RecordSuccess(ip)
	if got := check(th, ip); got != open {
		t.Fatalf("Check after success = %+v, want %+v", got, open)
	}
	// The backoff restarts at 30s instead of going on where it stopped.
	if got := fail(th, ip, FailuresBeforeLockout); got != locked(BaseLockout) {
		t.Fatalf("RecordFailure after success = %+v, want %+v", got, locked(BaseLockout))
	}
}

// auth-throttle.test.ts: "tracks addresses independently".
func TestThrottleTracksAddressesIndependently(t *testing.T) {
	th, _ := newTestThrottle()
	fail(th, ip, FailuresBeforeLockout)
	if got := check(th, ip); got.allowed {
		t.Fatalf("Check %s = %+v, want locked", ip, got)
	}
	if got := check(th, "10.0.0.9"); got != open {
		t.Fatalf("Check 10.0.0.9 = %+v, want %+v", got, open)
	}
}

// auth-throttle.test.ts: "never throttles when the address is unknown".
// The relay used null. Go uses the empty string.
func TestThrottleNeverThrottlesEmptyAddress(t *testing.T) {
	th, _ := newTestThrottle()
	for i := range 50 {
		if got := record(th, ""); got != open {
			t.Fatalf("failure %d: RecordFailure = %+v, want %+v", i+1, got, open)
		}
	}
	if got := check(th, ""); got != open {
		t.Fatalf("Check = %+v, want %+v", got, open)
	}
	if n := len(th.entries); n != 0 {
		t.Fatalf("entries = %d, want 0", n)
	}
}

// TestThrottleSchedule pins the full schedule from the spec.
func TestThrottleSchedule(t *testing.T) {
	th, _ := newTestThrottle()
	want := []decision{
		open, open, open, open, // failures 1 to 4
		locked(30 * time.Second),
		locked(60 * time.Second),
		locked(120 * time.Second),
		locked(240 * time.Second),
		locked(480 * time.Second),
		locked(900 * time.Second),
		locked(900 * time.Second),
	}
	for i, w := range want {
		if got := record(th, ip); got != w {
			t.Fatalf("failure %d = %+v, want %+v", i+1, got, w)
		}
	}
}

// TestThrottleZeroValue checks that a zero Throttle works on the real clock.
func TestThrottleZeroValue(t *testing.T) {
	var th Throttle
	fail(&th, ip, FailuresBeforeLockout)
	allowed, wait := th.Check(ip)
	if allowed || wait <= 0 || wait > BaseLockout {
		t.Fatalf("Check = %v, %v, want locked for up to %v", allowed, wait, BaseLockout)
	}
}

func TestThrottleKey(t *testing.T) {
	tests := []struct {
		addr, want string
	}{
		{"", ""},
		{"192.168.1.50", "192.168.1.50"},
		{"192.168.1.50:51234", "192.168.1.50"},
		{"::ffff:192.168.1.50", "192.168.1.50"},
		{"[::ffff:192.168.1.50]:443", "192.168.1.50"},
		{"fd00::1", "fd00::1"},
		{"[fd00::1]:443", "fd00::1"},
		{"FD00:0:0:0:0:0:0:1", "fd00::1"},
		{"unknown", "unknown"},
		{"@", "@"},
	}
	for _, tt := range tests {
		if got := key(tt.addr); got != tt.want {
			t.Errorf("key(%q) = %q, want %q", tt.addr, got, tt.want)
		}
	}
}

// TestThrottleOneHostOneEntry checks that ports and mapped forms of one
// host share a single backoff.
func TestThrottleOneHostOneEntry(t *testing.T) {
	th, _ := newTestThrottle()
	forms := []string{
		ip + ":40001",
		ip + ":40002",
		"::ffff:" + ip,
		"[::ffff:" + ip + "]:40003",
		ip,
	}
	var last decision
	for _, addr := range forms {
		last = record(th, addr)
	}
	if last != locked(BaseLockout) {
		t.Fatalf("fifth failure = %+v, want %+v", last, locked(BaseLockout))
	}
	if got := check(th, ip+":9"); got != locked(BaseLockout) {
		t.Fatalf("Check from another port = %+v, want %+v", got, locked(BaseLockout))
	}
}

// addrN is a distinct IPv4 address for i.
func addrN(i int) string {
	return netip.AddrFrom4([4]byte{10, byte(i >> 16), byte(i >> 8), byte(i)}).String()
}

// fill records one failure at the current clock for addresses 0 to n-1.
func fill(th *Throttle, n int) {
	for i := range n {
		th.RecordFailure(addrN(i))
	}
}

func TestThrottleSweepForgetsIdleEntries(t *testing.T) {
	tests := []struct {
		name  string
		idle  time.Duration
		count int
		want  int
	}{
		// Strictly longer than the TTL is forgotten.
		{"past TTL", entryTTL + time.Millisecond, sweepThreshold, 1},
		{"at TTL", entryTTL, sweepThreshold, sweepThreshold + 1},
		// Below the threshold nothing is scanned, however old. Relay
		// behaviour, kept.
		{"below threshold", 10 * entryTTL, sweepThreshold - 1, sweepThreshold},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			th, clock := newTestThrottle()
			fill(th, tt.count)
			clock.Set(t0.Add(tt.idle))
			th.RecordFailure("192.168.200.1")
			if got := len(th.entries); got != tt.want {
				t.Fatalf("entries = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestThrottleSweepKeepsLockedEntries(t *testing.T) {
	th, clock := newTestThrottle()
	fill(th, sweepThreshold)
	stale := t0.Add(-2 * entryTTL)
	th.entries[ip] = &entry{
		failures:    FailuresBeforeLockout,
		lockout:     BaseLockout,
		lockedUntil: t0.Add(entryTTL + time.Minute),
		touchedAt:   stale,
	}
	clock.Set(t0.Add(entryTTL + time.Millisecond))
	th.RecordFailure("192.168.200.1")
	if _, ok := th.entries[ip]; !ok {
		t.Fatal("locked entry was swept")
	}
	if got := len(th.entries); got != 2 {
		t.Fatalf("entries = %d, want 2", got)
	}
}

// fillAged puts n entries straight into the map, entry i touched at t0
// plus i milliseconds.
func fillAged(th *Throttle, n int) {
	th.entries = make(map[string]*entry, n)
	for i := range n {
		th.entries[addrN(i)] = &entry{failures: 1, touchedAt: t0.Add(time.Duration(i) * time.Millisecond)}
	}
}

func TestThrottleCapEvictsOldest(t *testing.T) {
	th, clock := newTestThrottle()
	fillAged(th, maxEntries)
	clock.Set(t0.Add(maxEntries * time.Millisecond))

	th.RecordFailure("192.168.200.1")
	if got := len(th.entries); got != maxEntries {
		t.Fatalf("entries after a new address = %d, want %d", got, maxEntries)
	}
	if _, ok := th.entries[addrN(0)]; ok {
		t.Fatal("oldest entry was kept")
	}
	for _, k := range []string{addrN(1), addrN(maxEntries - 1), "192.168.200.1"} {
		if _, ok := th.entries[k]; !ok {
			t.Fatalf("entry %s was evicted", k)
		}
	}

	// A known address needs no room. Nothing is evicted.
	th.RecordFailure(addrN(1))
	if got := len(th.entries); got != maxEntries {
		t.Fatalf("entries after a known address = %d, want %d", got, maxEntries)
	}
	if _, ok := th.entries[addrN(2)]; !ok {
		t.Fatal("entry evicted for a known address")
	}
}

// TestThrottleCapKeepsCurrentAddress checks that the address being
// recorded is never the one evicted, even when its last touch is oldest.
func TestThrottleCapKeepsCurrentAddress(t *testing.T) {
	th, clock := newTestThrottle()
	fillAged(th, maxEntries+1)
	clock.Set(t0.Add(maxEntries * time.Millisecond))

	if got := record(th, addrN(0)); got != open {
		t.Fatalf("RecordFailure = %+v, want %+v", got, open)
	}
	if got := len(th.entries); got != maxEntries {
		t.Fatalf("entries = %d, want %d", got, maxEntries)
	}
	e, ok := th.entries[addrN(0)]
	if !ok {
		t.Fatal("current address was evicted")
	}
	if e.failures != 2 {
		t.Fatalf("failures = %d, want 2", e.failures)
	}
	if _, ok := th.entries[addrN(1)]; ok {
		t.Fatal("second oldest entry was kept")
	}
}

// TestThrottleConcurrentUse runs one goroutine per address, enough of them
// to make every failure sweep, plus readers on a shared address. Run with
// -race.
func TestThrottleConcurrentUse(t *testing.T) {
	th, _ := newTestThrottle()
	const workers = 2 * sweepThreshold
	var wg sync.WaitGroup
	for i := range workers {
		addr := addrN(i)
		wg.Go(func() {
			for n := range FailuresBeforeLockout - 1 {
				if got := record(th, addr); got != open {
					t.Errorf("%s failure %d = %+v, want %+v", addr, n+1, got, open)
					return
				}
			}
			if got := record(th, addr); got != locked(BaseLockout) {
				t.Errorf("%s fifth failure = %+v, want %+v", addr, got, locked(BaseLockout))
				return
			}
			if got := check(th, addr); got != locked(BaseLockout) {
				t.Errorf("%s Check = %+v, want %+v", addr, got, locked(BaseLockout))
				return
			}
			th.RecordSuccess(addr)
			if got := check(th, addr); got != open {
				t.Errorf("%s Check after success = %+v, want %+v", addr, got, open)
			}
		})
		wg.Go(func() {
			check(th, ip)
			th.RecordSuccess(ip)
		})
	}
	wg.Wait()
	if n := len(th.entries); n != 0 {
		t.Fatalf("entries = %d, want 0", n)
	}
}
