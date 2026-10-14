// Package auth checks the first message on a browser connection. It
// compares the token in constant time and keeps a per address backoff for
// failed attempts. It ports apps/relay/src/auth.ts and auth-throttle.ts.
//
// The auth timeout belongs to the connection, not to this package.
package auth

import (
	"crypto/sha256"
	"crypto/subtle"
	"fmt"
	"time"

	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

// Reasons sent in auth:failure. The browser shows them as they are.
const (
	// ReasonNotAuth answers a first message that is not auth.
	ReasonNotAuth = "First message must be auth"
	// ReasonInvalidToken answers a token that does not match.
	ReasonInvalidToken = "Invalid token"
	// ReasonFailed is the fallback when no other reason applies.
	ReasonFailed = "Authentication failed"
)

// TokenEqual reports whether provided equals expected. Both sides are
// hashed with SHA-256 first. The digests always have the same length, so
// the compare runs in constant time and a length difference does not leak.
// Two empty strings are equal. Authenticate never accepts an empty
// expected token.
func TokenEqual(provided, expected string) bool {
	p := sha256.Sum256([]byte(provided))
	e := sha256.Sum256([]byte(expected))
	return subtle.ConstantTimeCompare(p[:], e[:]) == 1
}

// Result is the outcome of one auth attempt.
type Result struct {
	// OK is true when the token matched. The connection is authenticated.
	OK bool
	// Reason is the auth:failure reason. Empty when OK.
	Reason string
	// Throttled is true when the address was in backoff. The token was
	// ignored and nothing was recorded.
	Throttled bool
	// RetryAfter is how long the address stays locked out. Zero when it is
	// not locked.
	RetryAfter time.Duration
}

// Failure returns the auth:failure message for a failed result. An empty
// reason falls back to ReasonFailed, as the relay did.
func (r Result) Failure() *server.AuthFailure {
	reason := r.Reason
	if reason == "" {
		reason = ReasonFailed
	}
	return &server.AuthFailure{Type: "auth:failure", Reason: reason}
}

// Authenticate decides one auth attempt from addr. token is the configured
// AUTH_TOKEN. The order follows the relay:
//
//  1. A message that is not auth fails with ReasonNotAuth. Nothing is
//     recorded.
//  2. An address in backoff fails with "Too many failed attempts. Try again
//     in Ns." N is the wait in seconds, rounded up. Nothing is recorded, so
//     waiting is the only way out.
//  3. A wrong token fails with ReasonInvalidToken and counts as a failure.
//  4. A right token succeeds and clears the history of the address.
//
// An empty token never matches and fails with ReasonFailed. Config refuses
// an empty AUTH_TOKEN, so this is only a guard.
//
// addr is the client address. Empty means unknown and is never throttled.
// throttle must not be nil. Steps 2 to 4 run under the throttle lock, so
// parallel attempts from one address get no more tries than serial ones.
func Authenticate(msg client.Message, addr, token string, throttle *Throttle) Result {
	m, ok := msg.(*client.Auth)
	if !ok || m == nil {
		return Result{Reason: ReasonNotAuth}
	}
	if token == "" {
		return Result{Reason: ReasonFailed}
	}
	// Hash outside the lock. A locked address costs the same work.
	match := TokenEqual(m.Token, token)
	return throttle.settle(addr, match)
}

// settle applies the throttle to an attempt whose token was already
// compared. Check, record and clear happen under one lock.
func (t *Throttle) settle(addr string, match bool) Result {
	k := key(addr)
	if k == "" {
		if match {
			return Result{OK: true}
		}
		return Result{Reason: ReasonInvalidToken}
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.clock()
	if allowed, wait := t.check(k, now); !allowed {
		return Result{Reason: throttledReason(wait), Throttled: true, RetryAfter: wait}
	}
	if match {
		delete(t.entries, k)
		return Result{OK: true}
	}
	_, wait := t.recordFailure(k, now)
	return Result{Reason: ReasonInvalidToken, RetryAfter: wait}
}

// throttledReason is the reason for an address in backoff.
func throttledReason(wait time.Duration) string {
	return fmt.Sprintf("Too many failed attempts. Try again in %ds.", ceilSeconds(wait))
}

// ceilSeconds rounds d up to whole seconds, as Math.ceil(ms / 1000) did.
func ceilSeconds(d time.Duration) int64 {
	if d <= 0 {
		return 0
	}
	return int64((d + time.Second - 1) / time.Second)
}
