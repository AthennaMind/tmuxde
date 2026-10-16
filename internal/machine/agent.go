package machine

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"

	"tmuxde/internal/node"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

// Agent connects a local node to one hub. Each data stream is independent.
type Agent struct {
	URL    string
	Token  string
	CAFile string
	Info   Info
	Node   node.Node
	Files  node.FileOpener
	Logger *slog.Logger
	seq    atomic.Uint64
}

func (a *Agent) Run(ctx context.Context) error {
	client, err := a.httpClient()
	if err != nil {
		return err
	}
	defer client.CloseIdleConnections()
	delay := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		err := a.connect(ctx, client)
		if ctx.Err() != nil {
			return nil
		}
		if a.Logger != nil {
			a.Logger.Warn("agent disconnected", "error", err)
		}
		if time.Since(started) > time.Minute {
			delay = time.Second
		}
		timer := time.NewTimer(delay + time.Duration(rand.Int64N(int64(delay/2))))
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil
		case <-timer.C:
		}
		delay = min(delay*2, 30*time.Second)
	}
	return nil
}

func (a *Agent) httpClient() (*http.Client, error) {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	transport.TLSClientConfig = &tls.Config{MinVersion: tls.VersionTLS12}
	if a.CAFile != "" {
		roots, err := x509.SystemCertPool()
		if err != nil {
			roots = x509.NewCertPool()
		}
		b, err := os.ReadFile(a.CAFile)
		if err != nil {
			return nil, err
		}
		if !roots.AppendCertsFromPEM(b) {
			return nil, errors.New("CA file contains no certificates")
		}
		transport.TLSClientConfig.RootCAs = roots
	}
	return &http.Client{
		Transport: transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}, nil
}

func (a *Agent) dial(ctx context.Context, httpClient *http.Client, path, ticket string) (*websocket.Conn, error) {
	headers := http.Header{"Authorization": []string{"Bearer " + a.Token}}
	if ticket != "" {
		headers.Set("X-Tmuxde-Ticket", ticket)
	}
	dialCtx, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()
	c, resp, err := websocket.Dial(dialCtx, strings.TrimRight(a.URL, "/")+path, &websocket.DialOptions{HTTPClient: httpClient, HTTPHeader: headers})
	if err != nil {
		if resp != nil && resp.Body != nil {
			resp.Body.Close()
		}
		return nil, errors.New("agent connection failed")
	}
	c.SetReadLimit(maxFrame)
	return c, nil
}

func (a *Agent) connect(ctx context.Context, httpClient *http.Client) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	c, err := a.dial(ctx, httpClient, AgentPath, "")
	if err != nil {
		return err
	}
	defer c.CloseNow()
	if err := writeJSON(ctx, c, hello{Protocol: ProtocolVersion, Info: a.Info}); err != nil {
		return err
	}
	var welcome hello
	first, stop := context.WithTimeout(ctx, operationTimeout)
	err = readJSON(first, c, &welcome)
	stop()
	if err != nil {
		return err
	}
	if welcome.Protocol != ProtocolVersion {
		return errors.New("unsupported agent protocol")
	}
	if a.Logger != nil {
		a.Logger.Info("agent connected", "machine", welcome.Info.ID)
	}
	go agentHeartbeat(ctx, c, cancel)
	var wg sync.WaitGroup
	defer func() {
		cancel()
		wg.Wait()
	}()
	slots := make(chan struct{}, maxStreams)
	for {
		var req invitation
		if err := readJSON(ctx, c, &req); err != nil {
			return err
		}
		if len(req.Ticket) != 64 || (req.Kind != "node" && req.Kind != "file") {
			return errors.New("invalid stream invitation")
		}
		select {
		case slots <- struct{}{}:
		default:
			// A recently closed stream may still be cleaning up. Let this
			// invitation expire without disconnecting other browsers.
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-slots }()
			a.serveStream(ctx, httpClient, req)
		}()
	}
}

func (a *Agent) serveStream(ctx context.Context, httpClient *http.Client, req invitation) {
	c, err := a.dial(ctx, httpClient, StreamPath, req.Ticket)
	if err != nil {
		return
	}
	defer c.CloseNow()
	stop := context.AfterFunc(ctx, func() { c.CloseNow() })
	defer stop()
	if req.Kind == "file" {
		a.serveFile(ctx, c)
		return
	}
	id := node.ConnID(a.seq.Add(1))
	if err := a.Node.Open(ctx, id, agentSink{c}); err != nil {
		return
	}
	defer a.Node.Close(id)
	for {
		typ, b, err := c.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			return
		}
		msg, err := client.Decode(b)
		if err != nil {
			return
		}
		switch msg.WireType() {
		case "auth", "ping", "dictation:start", "dictation:audio", "dictation:stop", "dictation:cancel":
			return
		}
		if err := a.Node.Handle(ctx, id, msg); err != nil {
			if err := (agentSink{c}).Send(ctx, &server.Error{Type: "error", Code: "HANDLER_ERROR", Message: err.Error()}); err != nil {
				return
			}
		}
	}
}

type agentSink struct{ c *websocket.Conn }

func (s agentSink) Send(ctx context.Context, msg server.Message) error {
	b, err := server.Encode(msg)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()
	return s.c.Write(ctx, websocket.MessageText, b)
}

func (a *Agent) serveFile(ctx context.Context, c *websocket.Conn) {
	var req fileRequest
	if err := readJSON(ctx, c, &req); err != nil {
		return
	}
	f, err := a.Files.OpenFile(ctx, req.Path)
	if err != nil {
		code := "not-found"
		if errors.Is(err, node.ErrDenied) {
			code = "denied"
		}
		if errors.Is(err, node.ErrNotFile) {
			code = "not-file"
		}
		_ = writeJSON(ctx, c, fileReply{Error: code})
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = writeJSON(ctx, c, fileReply{Error: "not-file"})
		return
	}
	if err := writeJSON(ctx, c, fileReply{Name: info.Name(), Size: info.Size(), Modified: info.ModTime()}); err != nil {
		return
	}
	b := make([]byte, chunkSize)
	for {
		var read fileRequest
		if err := readJSON(ctx, c, &read); err != nil {
			return
		}
		if read.Path != "" || read.Offset < 0 || read.Length < 1 || read.Length > chunkSize {
			return
		}
		if _, err := f.Seek(read.Offset, io.SeekStart); err != nil {
			return
		}
		n, err := f.Read(b[:read.Length])
		if err != nil && !errors.Is(err, io.EOF) {
			return
		}
		send, cancel := context.WithTimeout(ctx, operationTimeout)
		err = c.Write(send, websocket.MessageBinary, b[:n])
		cancel()
		if err != nil {
			return
		}
	}
}

// agentHeartbeat detects a silent hub or broken route without waiting for TCP.
func agentHeartbeat(ctx context.Context, c *websocket.Conn, cancel context.CancelFunc) {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			probe, stop := context.WithTimeout(ctx, 10*time.Second)
			err := c.Ping(probe)
			stop()
			if err != nil {
				cancel()
				return
			}
		}
	}
}
