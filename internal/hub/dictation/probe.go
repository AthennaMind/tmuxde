package dictation

import (
	"context"
	"io"
	"net/http"
	"sync"
	"time"
)

// probeState is the health flag and the probe that owns it. Only the
// running probe writes up, and only while its context is live. The relay
// let a check that was in flight at stop write the flag after stop.
type probeState struct {
	mu      sync.Mutex
	gen     uint64 // bumped by every StartProbe that starts a probe
	ctx     context.Context
	running bool
	done    chan struct{}
	up      bool
}

// Available reports whether browsers should be offered a mic: a probe runs
// and its last health check passed. It turns false the moment the probe's
// context ends. It is meant for auth:success features.
func (b *Bridge) Available() bool {
	p := &b.probe
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.running && p.up && p.ctx.Err() == nil
}

// StartProbe polls the service's health check until ctx ends. The first
// check runs at once. Later ones follow ProbeUp after a pass and ProbeDown
// after a failure, so a service still loading its model shows up within
// seconds. Only a 2xx answer passes.
//
// StartProbe returns at once. The channel closes when the probe has
// stopped. Without a socket path nothing runs and the channel is closed
// already. While a probe runs, another call returns its channel and
// starts nothing.
func (b *Bridge) StartProbe(ctx context.Context) <-chan struct{} {
	done := make(chan struct{})
	if !b.Enabled() {
		close(done)
		return done
	}
	p := &b.probe
	p.mu.Lock()
	if p.running && p.ctx.Err() == nil {
		d := p.done
		p.mu.Unlock()
		return d
	}
	p.gen++
	gen := p.gen
	p.ctx, p.running, p.done, p.up = ctx, true, done, false
	p.mu.Unlock()

	go b.runProbe(ctx, gen, done)
	return done
}

func (b *Bridge) runProbe(ctx context.Context, gen uint64, done chan struct{}) {
	defer close(done)
	defer b.probeStopped(gen)
	for {
		ok := b.healthy(ctx)
		b.record(ctx, gen, ok)
		wait := b.opts.ProbeDown
		if ok {
			wait = b.opts.ProbeUp
		}
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}

// record stores one check result. A probe that was stopped or replaced
// writes nothing.
func (b *Bridge) record(ctx context.Context, gen uint64, ok bool) {
	p := &b.probe
	p.mu.Lock()
	defer p.mu.Unlock()
	if gen != p.gen || ctx.Err() != nil {
		return
	}
	if ok != p.up {
		b.log.Info("Speech service availability changed", "available", ok)
	}
	p.up = ok
}

func (b *Bridge) probeStopped(gen uint64) {
	p := &b.probe
	p.mu.Lock()
	defer p.mu.Unlock()
	if gen == p.gen {
		p.running = false
		p.up = false
	}
}

// healthy runs one health check. The body is ignored.
func (b *Bridge) healthy(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, b.opts.ProbeTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL, nil)
	if err != nil {
		return false
	}
	resp, err := b.healthClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
	return resp.StatusCode >= 200 && resp.StatusCode < 300
}
