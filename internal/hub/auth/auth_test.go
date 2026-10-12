package auth

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

// secret is the configured token in Authenticate tests.
const secret = "s3cret-token-0123456789"

func TestTokenEqual(t *testing.T) {
	tests := []struct {
		name               string
		provided, expected string
		want               bool
	}{
		// auth.test.ts: "accepts an exactly-matching token".
		{"AcceptsExactMatch", "s3cret-token", "s3cret-token", true},
		// auth.test.ts: "rejects a wrong token of the same length".
		{"RejectsWrongSameLength", "s3cret-tokeX", "s3cret-token", false},
		// auth.test.ts: "rejects a wrong token of a different length".
		{"RejectsWrongShorter", "short", "s3cret-token", false},
		{"RejectsWrongLonger", "s3cret-token-and-then-some", "s3cret-token", false},
		// auth.test.ts: "rejects an empty provided token".
		{"RejectsEmptyProvided", "", "s3cret-token", false},
		// auth.test.ts: "handles both sides empty (degenerate) as equal".
		// Both digests are SHA-256 of "", so they match. Authenticate
		// refuses an empty expected token before it gets here.
		{"BothEmptyEqual", "", "", true},
		// Tokens compare as bytes, not as normalised text.
		{"RejectsOtherNormalForm", "caf\u00e9", "cafe\u0301", false},
		{"AcceptsSameNonASCII", "caf\u00e9", "caf\u00e9", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := TokenEqual(tt.provided, tt.expected); got != tt.want {
				t.Fatalf("TokenEqual(%q, %q) = %v, want %v", tt.provided, tt.expected, got, tt.want)
			}
		})
	}
}

func authMsg(token string) *client.Auth {
	return &client.Auth{Type: "auth", Token: token}
}

func TestAuthenticate(t *testing.T) {
	tests := []struct {
		name  string
		addr  string
		token string
		// prior wrong tokens sent through Authenticate from addr first.
		prior int
		msg   client.Message
		want  Result
		// after is the result of one more wrong token from addr. It shows
		// what the attempt under test recorded.
		after Result
	}{
		{
			name: "NotAuthFirst", addr: ip, token: secret, prior: 4,
			msg:   &client.Ping{Type: "ping", Timestamp: 1},
			want:  Result{Reason: ReasonNotAuth},
			after: Result{Reason: ReasonInvalidToken, RetryAfter: BaseLockout},
		},
		{
			name: "NilMessage", addr: ip, token: secret,
			msg:   nil,
			want:  Result{Reason: ReasonNotAuth},
			after: Result{Reason: ReasonInvalidToken},
		},
		{
			name: "TypedNilAuth", addr: ip, token: secret,
			msg:   (*client.Auth)(nil),
			want:  Result{Reason: ReasonNotAuth},
			after: Result{Reason: ReasonInvalidToken},
		},
		{
			name: "RightToken", addr: ip, token: secret, prior: 4,
			msg:   authMsg(secret),
			want:  Result{OK: true},
			after: Result{Reason: ReasonInvalidToken},
		},
		{
			name: "WrongToken", addr: ip, token: secret, prior: 3,
			msg:   authMsg("guess"),
			want:  Result{Reason: ReasonInvalidToken},
			after: Result{Reason: ReasonInvalidToken, RetryAfter: BaseLockout},
		},
		{
			name: "FifthWrongTokenLocks", addr: ip, token: secret, prior: 4,
			msg:  authMsg("guess"),
			want: Result{Reason: ReasonInvalidToken, RetryAfter: BaseLockout},
			after: Result{
				Reason:     "Too many failed attempts. Try again in 30s.",
				Throttled:  true,
				RetryAfter: BaseLockout,
			},
		},
		{
			name: "LockedRightToken", addr: ip, token: secret, prior: 5,
			msg: authMsg(secret),
			want: Result{
				Reason:     "Too many failed attempts. Try again in 30s.",
				Throttled:  true,
				RetryAfter: BaseLockout,
			},
			after: Result{
				Reason:     "Too many failed attempts. Try again in 30s.",
				Throttled:  true,
				RetryAfter: BaseLockout,
			},
		},
		{
			name: "EmptyAddressNeverThrottled", addr: "", token: secret, prior: 20,
			msg:   authMsg("guess"),
			want:  Result{Reason: ReasonInvalidToken},
			after: Result{Reason: ReasonInvalidToken},
		},
		{
			name: "EmptyAddressRightToken", addr: "", token: secret, prior: 20,
			msg:   authMsg(secret),
			want:  Result{OK: true},
			after: Result{Reason: ReasonInvalidToken},
		},
		{
			name: "EmptyConfiguredToken", addr: ip, token: "", prior: 4,
			msg:   authMsg(""),
			want:  Result{Reason: ReasonFailed},
			after: Result{Reason: ReasonFailed},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			th, _ := newTestThrottle()
			for range tt.prior {
				Authenticate(authMsg("guess"), tt.addr, tt.token, th)
			}
			if got := Authenticate(tt.msg, tt.addr, tt.token, th); got != tt.want {
				t.Fatalf("Authenticate = %+v, want %+v", got, tt.want)
			}
			if got := Authenticate(authMsg("guess"), tt.addr, tt.token, th); got != tt.after {
				t.Fatalf("next wrong token = %+v, want %+v", got, tt.after)
			}
		})
	}
}

// TestAuthenticateLockedRecordsNothing checks that attempts during a
// lockout do not extend it. Only the next failure after it ends doubles.
func TestAuthenticateLockedRecordsNothing(t *testing.T) {
	th, clock := newTestThrottle()
	for range FailuresBeforeLockout {
		Authenticate(authMsg("guess"), ip, secret, th)
	}
	for i := range 10 {
		clock.Set(t0.Add(time.Duration(i) * time.Second))
		token := "guess"
		if i%2 == 1 {
			token = secret
		}
		if got := Authenticate(authMsg(token), ip, secret, th); !got.Throttled || got.OK {
			t.Fatalf("attempt %d during lockout = %+v, want throttled", i, got)
		}
	}
	clock.Set(t0.Add(BaseLockout))
	want := Result{Reason: ReasonInvalidToken, RetryAfter: 2 * BaseLockout}
	if got := Authenticate(authMsg("guess"), ip, secret, th); got != want {
		t.Fatalf("first failure after lockout = %+v, want %+v", got, want)
	}
}

// TestAuthenticateSuccessClearsHistory checks that a right token resets the
// count, so five more failures are needed for a lockout.
func TestAuthenticateSuccessClearsHistory(t *testing.T) {
	th, _ := newTestThrottle()
	for range FailuresBeforeLockout - 1 {
		Authenticate(authMsg("guess"), ip, secret, th)
	}
	if got := Authenticate(authMsg(secret), ip, secret, th); !got.OK {
		t.Fatalf("right token = %+v, want OK", got)
	}
	for i := range FailuresBeforeLockout - 1 {
		want := Result{Reason: ReasonInvalidToken}
		if got := Authenticate(authMsg("guess"), ip, secret, th); got != want {
			t.Fatalf("failure %d = %+v, want %+v", i+1, got, want)
		}
	}
	want := Result{Reason: ReasonInvalidToken, RetryAfter: BaseLockout}
	if got := Authenticate(authMsg("guess"), ip, secret, th); got != want {
		t.Fatalf("fifth failure = %+v, want %+v", got, want)
	}
}

// TestAuthenticateRetryRoundsUp checks that the wait in the reason is
// whole seconds rounded up, as Math.ceil(ms / 1000).
func TestAuthenticateRetryRoundsUp(t *testing.T) {
	tests := []struct {
		elapsed time.Duration
		seconds int
	}{
		{0, 30},
		{time.Nanosecond, 30},
		{time.Millisecond, 30},
		{999 * time.Millisecond, 30},
		{time.Second, 29},
		{1001 * time.Millisecond, 29},
		{29 * time.Second, 1},
		{BaseLockout - time.Nanosecond, 1},
	}
	for _, tt := range tests {
		t.Run(tt.elapsed.String(), func(t *testing.T) {
			th, clock := newTestThrottle()
			for range FailuresBeforeLockout {
				Authenticate(authMsg("guess"), ip, secret, th)
			}
			clock.Set(t0.Add(tt.elapsed))
			got := Authenticate(authMsg(secret), ip, secret, th)
			want := fmt.Sprintf("Too many failed attempts. Try again in %ds.", tt.seconds)
			if got.Reason != want || got.RetryAfter != BaseLockout-tt.elapsed {
				t.Fatalf("Authenticate = %+v, want reason %q and wait %v", got, want, BaseLockout-tt.elapsed)
			}
		})
	}
}

func TestResultFailure(t *testing.T) {
	tests := []struct {
		name   string
		result Result
		want   string
	}{
		{"Fallback", Result{}, `{"type":"auth:failure","reason":"Authentication failed"}`},
		{"NotAuth", Result{Reason: ReasonNotAuth}, `{"type":"auth:failure","reason":"First message must be auth"}`},
		{"InvalidToken", Result{Reason: ReasonInvalidToken, RetryAfter: BaseLockout}, `{"type":"auth:failure","reason":"Invalid token"}`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data, err := server.Encode(tt.result.Failure())
			if err != nil {
				t.Fatalf("Encode: %v", err)
			}
			if string(data) != tt.want {
				t.Fatalf("Encode = %s, want %s", data, tt.want)
			}
		})
	}
}

// TestAuthenticateConcurrentAttempts sends many wrong tokens from one
// address at once. Exactly five may be compared. The rest must be refused
// by the lockout, as when the relay handled them one after another. Right
// tokens from another address pass meanwhile. Run with -race.
func TestAuthenticateConcurrentAttempts(t *testing.T) {
	th, _ := newTestThrottle()
	const attackers, users = 64, 16
	var (
		wg      sync.WaitGroup
		mu      sync.Mutex
		reasons = map[string]int{}
	)
	for range attackers {
		wg.Go(func() {
			got := Authenticate(authMsg("guess"), ip, secret, th)
			mu.Lock()
			reasons[got.Reason]++
			mu.Unlock()
		})
	}
	for range users {
		wg.Go(func() {
			if got := Authenticate(authMsg(secret), "192.168.1.51:40000", secret, th); !got.OK {
				t.Errorf("right token from another address = %+v, want OK", got)
			}
		})
	}
	wg.Wait()
	want := map[string]int{
		ReasonInvalidToken: FailuresBeforeLockout,
		"Too many failed attempts. Try again in 30s.": attackers - FailuresBeforeLockout,
	}
	if len(reasons) != len(want) {
		t.Fatalf("reasons = %v, want %v", reasons, want)
	}
	for reason, n := range want {
		if reasons[reason] != n {
			t.Fatalf("reasons = %v, want %v", reasons, want)
		}
	}
}
