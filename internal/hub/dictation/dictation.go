// Package dictation is the hub's bridge to the speech to text service. It
// ports apps/relay/src/dictation.ts.
//
// The service runs in its own container and listens on a unix socket. The
// bridge reaches it over that socket only: one WebSocket on /v1/stream per
// dictation and GET /health for the probe. The host part of both URLs is
// never resolved.
//
// One browser connection holds one Session, and a Session runs at most one
// dictation. A new start ends the old one without a word. Every dictation
// ends exactly once: with dictation:done, with dictation:error, or quietly
// on cancel, replacement and disconnect. Nothing about a dictation reaches
// the browser after it ended.
//
// The probe decides only whether browsers are offered a mic. A start is
// tried even while the probe says the service is down.
//
// serve and the ws layer wire it like this:
//
//	b := dictation.New(dictation.Options{SocketPath: cfg.STTSocket})
//	done := b.StartProbe(ctx)    // serve, stops with ctx
//	ws.Options{Dictation: b}     // auth:success asks b.Available
//	sess := b.NewSession()       // per connection, on its first dictation message
//	conn.OnClose(sess.Close)     // before the node's close hook
//	sess.Start(ctx, id, send)    // dictation:start
//	reply := sess.Audio(id, pcm) // dictation:audio, pcm from DecodePCM
//	reply := sess.Stop(id)       // dictation:stop
//	sess.Cancel(id, false)       // dictation:cancel
//
// A non-nil reply from Audio or Stop is NOT_FOUND for the caller to send.
package dictation

import (
	"context"
	"encoding/base64"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Defaults for the Options tunables. They match the relay.
const (
	DefaultConnectTimeout = 5 * time.Second
	// DefaultMaxSession is a backstop for a dictation nobody ends. The
	// service itself stops taking audio at 10 minutes.
	DefaultMaxSession = 15 * time.Minute
	// DefaultMaxBuffered is about 30 s of speech.
	DefaultMaxBuffered  = 1 << 20
	DefaultReadLimit    = 256 << 10
	DefaultMaxText      = 20_000
	DefaultProbeUp      = 30 * time.Second
	DefaultProbeDown    = 5 * time.Second
	DefaultProbeTimeout = 3 * time.Second
)

// URLs on the service socket. The dialer ignores the host.
const (
	streamURL = "ws://stt/v1/stream"
	healthURL = "http://stt/health"
)

// Options configure New. Zero tunables pick the defaults.
type Options struct {
	// SocketPath is the unix socket of the speech service. Empty means
	// dictation is not enabled on this machine.
	SocketPath string
	// Logger gets warnings and availability changes. Nil means
	// slog.Default().
	Logger *slog.Logger

	// ConnectTimeout bounds dial and handshake of one dictation.
	ConnectTimeout time.Duration
	// MaxSession ends a dictation that runs this long.
	MaxSession time.Duration
	// MaxBuffered caps audio bytes held for the service, both while the
	// connection opens and while it is open.
	MaxBuffered int
	// ReadLimit caps one message from the service.
	ReadLimit int64
	// MaxText caps the text of one service message, in UTF-16 code units
	// as Zod counts them.
	MaxText int
	// ProbeUp is the health check interval while the service is up.
	ProbeUp time.Duration
	// ProbeDown is the health check interval while the service is down.
	ProbeDown time.Duration
	// ProbeTimeout bounds one health check.
	ProbeTimeout time.Duration

	// Dial opens a connection to the service. Nil dials SocketPath. It is
	// used only when SocketPath is set. Tests replace it.
	Dial func(ctx context.Context) (net.Conn, error)
}

// Bridge connects browser dictations to the speech service. Create it with
// New. It is safe for concurrent use.
type Bridge struct {
	opts         Options
	log          *slog.Logger
	streamClient *http.Client // WebSocket handshakes
	healthClient *http.Client // probe

	probe probeState
	// wg counts the goroutines of every dictation: dial, reader, writer
	// and close. Tests wait on it.
	wg sync.WaitGroup
}

// New returns a bridge. It starts nothing. Call StartProbe for the health
// probe and NewSession for each browser connection.
func New(opts Options) *Bridge {
	if opts.Logger == nil {
		opts.Logger = slog.Default()
	}
	setDefault(&opts.ConnectTimeout, DefaultConnectTimeout)
	setDefault(&opts.MaxSession, DefaultMaxSession)
	setDefault(&opts.MaxBuffered, DefaultMaxBuffered)
	setDefault(&opts.ReadLimit, DefaultReadLimit)
	setDefault(&opts.MaxText, DefaultMaxText)
	setDefault(&opts.ProbeUp, DefaultProbeUp)
	setDefault(&opts.ProbeDown, DefaultProbeDown)
	setDefault(&opts.ProbeTimeout, DefaultProbeTimeout)
	if opts.Dial == nil {
		path := opts.SocketPath
		opts.Dial = func(ctx context.Context) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "unix", path)
		}
	}
	return &Bridge{
		opts:         opts,
		log:          opts.Logger,
		streamClient: &http.Client{Transport: transport(opts.Dial)},
		healthClient: &http.Client{Transport: transport(opts.Dial)},
	}
}

// Enabled reports whether a speech service is configured.
func (b *Bridge) Enabled() bool {
	return b.opts.SocketPath != ""
}

// transport sends every request over dial. No proxy, no keep-alive: the
// service is local, and a connection per request leaves nothing idle.
func transport(dial func(context.Context) (net.Conn, error)) *http.Transport {
	return &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return dial(ctx)
		},
		DisableKeepAlives:  true,
		DisableCompression: true,
	}
}

// goroutine runs fn in a goroutine counted by wg.
func (b *Bridge) goroutine(fn func()) {
	b.wg.Add(1)
	go func() {
		defer b.wg.Done()
		fn()
	}()
}

func setDefault[T time.Duration | int | int64](v *T, def T) {
	if *v <= 0 {
		*v = def
	}
}

// DecodePCM decodes the pcm field of dictation:audio as Node's
// Buffer.from(pcm, "base64") did. Padding is optional and a trailing
// partial group of one character is dropped. The schema already limits pcm
// to the base64 alphabet, so an error means the caller skipped the schema.
func DecodePCM(pcm string) ([]byte, error) {
	s := strings.TrimRight(pcm, "=")
	if len(s)%4 == 1 {
		s = s[:len(s)-1]
	}
	out, err := base64.RawStdEncoding.DecodeString(s)
	if err != nil {
		return nil, fmt.Errorf("dictation: decode pcm: %w", err)
	}
	return out, nil
}
