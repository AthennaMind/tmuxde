package ws

import (
	"context"
	"errors"
	"runtime"

	"github.com/coder/websocket"

	"tmuxde/internal/hub/accesslog"
	"tmuxde/internal/hub/auth"
	"tmuxde/internal/hub/conns"
	"tmuxde/internal/hub/dictation"
	"tmuxde/internal/hub/useragent"
	"tmuxde/internal/node"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

// handleFrame runs the per frame steps after the idle clock is touched:
// rate limit, decode, then auth or routing.
func (k *socket) handleFrame(data []byte) {
	ph := k.getPhase()
	if ph == phaseFailed {
		// auth:failure and the close are queued. Nothing said now counts,
		// and it must not count against the throttle either.
		return
	}
	if !k.limiter.allow(k.srv.opts.Now()) {
		k.reply(errorMessage(CodeRateLimited, textRateLimited))
		return
	}
	msg, err := client.Decode(data)
	if err != nil {
		// An unknown type fails here too, as it failed the relay's schema.
		// That covers dropped types such as device:* and pair:*. The web
		// client expects INVALID_MESSAGE for them, not UNKNOWN_MESSAGE.
		k.reply(errorMessage(CodeInvalidMessage, err.Error()))
		return
	}
	if ph == phaseUnauth {
		k.authenticate(msg)
		return
	}
	k.enqueue(func(ctx context.Context) { k.dispatch(ctx, msg) })
}

// authTimedOut fires AuthTimeout after admission unless a valid frame
// came first.
func (k *socket) authTimedOut() {
	k.mu.Lock()
	if k.phase != phaseUnauth {
		k.mu.Unlock()
		return
	}
	k.phase = phaseFailed
	k.mu.Unlock()
	k.log.Info("auth timeout")
	k.replyThenClose(authFailure(reasonAuthTimeout), websocket.StatusNoStatusRcvd, "")
}

// authenticate handles the first frame that passed rate limit and decode.
// It stops the auth timer whatever the outcome. A failure sends
// auth:failure and closes without a status code, as the relay's
// ws.close() did.
func (k *socket) authenticate(msg client.Message) {
	k.mu.Lock()
	if k.phase != phaseUnauth {
		k.mu.Unlock()
		return
	}
	k.phase = phaseAuthing
	k.authTimer.Stop()
	k.mu.Unlock()

	res := auth.Authenticate(msg, k.conn.RemoteAddr(), k.srv.opts.Token, k.srv.throttle)
	if !res.OK {
		k.setPhase(phaseFailed)
		k.log.Info("auth failed", "reason", res.Reason, "throttled", res.Throttled)
		k.replyThenClose(res.Failure(), websocket.StatusNoStatusRcvd, "")
		return
	}
	k.welcome()
}

// welcome admits an authenticated socket, in the relay's order: mark it
// authenticated, which notifies registry listeners, log the connect, send
// auth:success and server:info, then start liveness. The node is opened
// after the two replies are queued, so anything it sends comes after them.
//
// Close hooks run in the order they are added. Dictation is added before
// the node, so a removed connection ends its dictation first, as the
// relay's removeConnection did.
func (k *socket) welcome() {
	label := useragent.Describe(k.ua)
	if label == "" {
		label = conns.FallbackLabel
	}
	if !k.conn.Authenticate(label) {
		// Disconnect removed the connection while auth ran. Its close is
		// on the way. Nothing was logged or sent, so nothing is owed.
		k.setPhase(phaseFailed)
		return
	}
	k.setPhase(phaseAuthed)
	k.log.Info("authenticated", "label", label)

	// The relay logged the grant label, which is null for the machine
	// token. The user agent stays out of the log.
	k.srv.opts.AccessLog.Record(accesslog.Event{
		At:        k.srv.opts.Now(),
		Kind:      accesslog.Connected,
		Transport: accesslog.Transport(k.conn.RemoteAddr()),
	})

	k.reply(&server.AuthSuccess{
		Type:          "auth:success",
		ServerVersion: ServerVersion,
		// Advisory. The machine token always holds the full grant.
		Capabilities: &server.Capabilities{ReadOnly: false, Files: "write", Scope: "all"},
		Features:     Features(k.srv.opts.DictationAvailable()),
	})
	info := &server.ServerInfo{
		Type:     "server:info",
		Hostname: k.srv.opts.Hostname(),
		Platform: runtime.GOOS,
		Uptime:   k.srv.opts.Uptime(),
	}
	if p := k.srv.opts.DefaultPath; p != "" {
		info.DefaultPath = &p
	}
	k.reply(info)

	// A closed tab must not keep a speech service slot.
	k.conn.OnClose(k.closeDictation)

	id := k.nodeID()
	if err := k.srv.opts.Node.Open(k.conn.Context(), id, sink{k}); err != nil {
		k.log.Error("node open failed", "error", err)
		// Queued, so the close does not overtake the two replies.
		k.setPhase(phaseFailed)
		k.queueClose(websocket.StatusInternalError, reasonInternal)
		return
	}
	k.conn.OnClose(func() { k.srv.opts.Node.Close(id) })

	k.workers.Add(1)
	go k.keepAlive()
}

func (k *socket) nodeID() node.ConnID {
	return node.ConnID(k.conn.Seq())
}

// enqueue adds work to the connection's serial queue. After the close path
// has started the queue refuses it, and the work is dropped.
func (k *socket) enqueue(work func(ctx context.Context)) {
	k.conn.Enqueue(func(ctx context.Context) error {
		work(ctx)
		return nil
	})
}

// dispatch routes one message after auth. The hub answers auth, ping and
// dictation. The node gets the rest.
func (k *socket) dispatch(ctx context.Context, msg client.Message) {
	switch m := msg.(type) {
	case *client.Auth:
		k.answer(ctx, errorMessage(CodeAlreadyAuthenticated, textAlreadyAuthed))
	case *client.Ping:
		k.answer(ctx, &server.Pong{Type: "pong", Timestamp: m.Timestamp})
	case *client.DictationStart, *client.DictationAudio, *client.DictationStop, *client.DictationCancel:
		k.dictation(ctx, msg)
	default:
		err := k.srv.opts.Node.Handle(ctx, k.nodeID(), msg)
		if err == nil {
			return
		}
		if ctx.Err() != nil || k.conn.Closing() {
			// The connection is gone. Nobody is left to tell.
			k.log.Debug("handler ended with the connection", "type", msg.WireType(), "error", err)
			return
		}
		k.log.Error("message handler failed", "type", msg.WireType(), "error", err)
		k.answer(ctx, errorMessage(CodeHandlerError, err.Error()))
	}
}

// dictation hands a dictation message to the connection's session. What
// the speech service says later goes out through dictationSend. Audio and
// stop for a dictation that does not run get NOT_FOUND here, in order with
// the other replies. Cancel never gets an answer.
func (k *socket) dictation(ctx context.Context, msg client.Message) {
	sess := k.dictationSession()
	if sess == nil {
		// The connection is gone. Nobody is left to tell.
		return
	}
	switch m := msg.(type) {
	case *client.DictationStart:
		sess.Start(ctx, m.ID, k.dictationSend)
	case *client.DictationAudio:
		// The schema allowed only the base64 alphabet, so this decodes
		// as Node did and does not fail.
		pcm, err := dictation.DecodePCM(m.PCM)
		if err != nil {
			k.answer(ctx, errorMessage(CodeInvalidMessage, err.Error()))
			return
		}
		k.answerIf(ctx, sess.Audio(m.ID, pcm))
	case *client.DictationStop:
		k.answerIf(ctx, sess.Stop(m.ID))
	case *client.DictationCancel:
		sess.Cancel(m.ID, false)
	}
}

// dictationSession returns the connection's dictation session and makes
// it on first use. It returns nil once the connection is removed.
func (k *socket) dictationSession() *dictation.Session {
	k.dictMu.Lock()
	defer k.dictMu.Unlock()
	if k.dictClosed {
		return nil
	}
	if k.dict == nil {
		k.dict = k.srv.opts.Dictation.NewSession()
	}
	return k.dict
}

// closeDictation ends the running dictation quietly and keeps the slot
// closed. It is a close hook.
func (k *socket) closeDictation() {
	k.dictMu.Lock()
	sess := k.dict
	k.dict = nil
	k.dictClosed = true
	k.dictMu.Unlock()
	if sess != nil {
		sess.Close()
	}
}

// dictationSend is how a dictation talks to the browser: through the
// sink, behind every reply queued before. The session holds its lock
// while it sends, so the wait for room in the queue ends when the
// connection is removed, before the close hooks run.
func (k *socket) dictationSend(msg server.Message) error {
	return sink{k}.Send(k.conn.Context(), msg)
}

// answer sends a reply from queued work. It waits for room in the queue
// like a node message would.
func (k *socket) answer(ctx context.Context, msg server.Message) {
	if err := k.send(ctx, msg); err != nil && !errors.Is(err, ErrClosed) && ctx.Err() == nil {
		k.log.Error("reply failed", "type", msg.WireType(), "error", err)
	}
}

// answerIf sends msg unless it is nil.
func (k *socket) answerIf(ctx context.Context, msg server.Message) {
	if msg != nil {
		k.answer(ctx, msg)
	}
}

func errorMessage(code, text string) *server.Error {
	return &server.Error{Type: "error", Code: code, Message: text}
}

func authFailure(reason string) *server.AuthFailure {
	return &server.AuthFailure{Type: "auth:failure", Reason: reason}
}

// sink is the node's view of a socket: one bounded queue, shared with the
// hub's own replies, so order holds across both.
type sink struct{ k *socket }

func (s sink) Send(ctx context.Context, msg server.Message) error {
	return s.k.send(ctx, msg)
}
