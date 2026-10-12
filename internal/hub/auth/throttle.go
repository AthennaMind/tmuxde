package auth

import (
	"net/netip"
	"slices"
	"strings"
	"sync"
	"time"
)

// Backoff schedule, the same as the relay. The first four failures are
// free. The fifth locks the address out for BaseLockout. Each further
// failure doubles the lockout up to MaxLockout. One success clears it all.
// A user who mistypes never notices. A script gets about five tries per
// quarter hour.
const (
	FailuresBeforeLockout = 5
	BaseLockout           = 30 * time.Second
	MaxLockout            = 15 * time.Minute
)

const (
	// entryTTL is how long an idle address is remembered.
	entryTTL = time.Hour
	// maxEntries caps the number of tracked addresses.
	maxEntries = 10_000
	// sweepThreshold is the map size from which a failure sweeps old
	// entries. Smaller maps are never scanned.
	sweepThreshold = 256
)

// entry is the failure history of one address.
type entry struct {
	failures int
	// lockedUntil is the end of the lockout. Zero before the first one.
	lockedUntil time.Time
	// lockout is the current lockout length. It doubles on each failure
	// past the threshold.
	lockout   time.Duration
	touchedAt time.Time
}

// Throttle is a per address backoff for failed auth. The zero value is
// ready to use and reads time.Now. It is safe for concurrent use.
//
// Addresses are keyed by host. A port is dropped and an IPv4 mapped IPv6
// address counts as plain IPv4, so one host is one entry however it
// connects. Strings that are not IP addresses are used as they are.
type Throttle struct {
	mu      sync.Mutex
	now     func() time.Time
	entries map[string]*entry
}

// NewThrottle returns a throttle that reads the time from now. A nil now
// means time.Now.
func NewThrottle(now func() time.Time) *Throttle {
	return &Throttle{now: now}
}

// Check reports whether addr may try to authenticate now. When it may not,
// retryAfter is the time left in the lockout. An empty addr is always
// allowed.
func (t *Throttle) Check(addr string) (allowed bool, retryAfter time.Duration) {
	k := key(addr)
	if k == "" {
		return true, 0
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.check(k, t.clock())
}

// RecordFailure counts a failed attempt from addr. It returns the decision
// for the next attempt, so the caller can say how long to wait. It counts
// even while addr is locked out. Authenticate refuses a locked address
// before it gets here. An empty addr is never recorded.
func (t *Throttle) RecordFailure(addr string) (allowed bool, retryAfter time.Duration) {
	k := key(addr)
	if k == "" {
		return true, 0
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.recordFailure(k, t.clock())
}

// RecordSuccess forgets the whole history of addr.
func (t *Throttle) RecordSuccess(addr string) {
	k := key(addr)
	if k == "" {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.entries, k)
}

func (t *Throttle) clock() time.Time {
	if t.now == nil {
		return time.Now()
	}
	return t.now()
}

// check needs t.mu held.
func (t *Throttle) check(k string, now time.Time) (bool, time.Duration) {
	e := t.entries[k]
	if e == nil || !e.lockedUntil.After(now) {
		return true, 0
	}
	return false, e.lockedUntil.Sub(now)
}

// recordFailure needs t.mu held.
func (t *Throttle) recordFailure(k string, now time.Time) (bool, time.Duration) {
	t.sweep(now, k)
	if t.entries == nil {
		t.entries = make(map[string]*entry)
	}
	e := t.entries[k]
	if e == nil {
		e = &entry{}
		t.entries[k] = e
	}
	e.failures++
	e.touchedAt = now
	if e.failures >= FailuresBeforeLockout {
		if e.lockout == 0 {
			e.lockout = BaseLockout
		} else {
			e.lockout = min(e.lockout*2, MaxLockout)
		}
		e.lockedUntil = now.Add(e.lockout)
	}
	if e.lockedUntil.After(now) {
		return false, e.lockedUntil.Sub(now)
	}
	return true, 0
}

// sweep needs t.mu held. It runs only once the map has sweepThreshold
// entries. It drops entries idle longer than entryTTL that are not locked.
// Then it evicts the oldest entries by touchedAt until the entry for keep
// fits under maxEntries. keep is about to be touched, so it is the newest
// and never evicted. The relay could end one entry over the cap. Here the
// new entry gets its room first.
func (t *Throttle) sweep(now time.Time, keep string) {
	if len(t.entries) < sweepThreshold {
		return
	}
	for k, e := range t.entries {
		if now.Sub(e.touchedAt) > entryTTL && !e.lockedUntil.After(now) {
			delete(t.entries, k)
		}
	}
	limit := maxEntries
	if _, ok := t.entries[keep]; !ok {
		limit--
	}
	excess := len(t.entries) - limit
	if excess <= 0 {
		return
	}
	type aged struct {
		key string
		at  time.Time
	}
	old := make([]aged, 0, len(t.entries))
	for k, e := range t.entries {
		if k != keep {
			old = append(old, aged{k, e.touchedAt})
		}
	}
	slices.SortFunc(old, func(a, b aged) int {
		if c := a.at.Compare(b.at); c != 0 {
			return c
		}
		return strings.Compare(a.key, b.key)
	})
	for _, o := range old[:excess] {
		delete(t.entries, o.key)
	}
}

// key is the map key for addr: the host without port, IPv4 mapped IPv6
// unmapped. Anything that is not an IP address is kept as it is.
func key(addr string) string {
	if ap, err := netip.ParseAddrPort(addr); err == nil {
		return ap.Addr().Unmap().String()
	}
	if a, err := netip.ParseAddr(addr); err == nil {
		return a.Unmap().String()
	}
	return addr
}
