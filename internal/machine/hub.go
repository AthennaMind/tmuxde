package machine

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"tmuxde/internal/hub/auth"
	"tmuxde/internal/node"
)

// Hub manages live agents. Local node remains optional.
type Hub struct {
	Dir          string
	BrowserToken string
	Local        node.Node
	LocalFiles   node.FileOpener
	LocalInfo    Info
	mu           sync.Mutex
	links        map[string]*link
	closed       bool
}

type link struct {
	hub     *Hub
	record  Record
	info    Info
	ws      *websocket.Conn
	ctx     context.Context
	cancel  context.CancelFunc
	mu      sync.Mutex
	pending map[string]chan *stream
	slots   chan struct{}
}

type stream struct {
	ws   *websocket.Conn
	done chan struct{}
	once sync.Once
}

func (s *stream) close() {
	s.once.Do(func() {
		s.ws.CloseNow()
		close(s.done)
	})
}

func NewHub(dir, browserToken string) *Hub {
	return &Hub{
		Dir:          dir,
		BrowserToken: browserToken,
		links:        make(map[string]*link),
	}
}

func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	for _, l := range h.links {
		l.cancel()
		l.ws.CloseNow()
	}
}

func (h *Hub) record(token string) (Record, error) {
	records, err := Records(h.Dir)
	if err != nil {
		return Record{}, err
	}
	hash := tokenHash(token)
	for _, r := range records {
		if !r.Revoked && auth.TokenEqual(hash, r.Hash) {
			return r, nil
		}
	}
	return Record{}, errors.New("invalid machine credential")
}

// ServeHTTP serves agent admission, data sockets and authenticated inventory.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodGet {
		http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	token, bearer := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !bearer {
		token = ""
	}
	if r.URL.Path == MachinesPath {
		if token == "" || !auth.TokenEqual(token, h.BrowserToken) {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		infos, err := h.List()
		if err != nil {
			http.Error(w, "Machine registry unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if err := writeInventory(w, infos); err != nil {
			return
		}
		return
	}
	if r.URL.Path != AgentPath && r.URL.Path != StreamPath {
		http.NotFound(w, r)
		return
	}
	// Agents never use browser origins or browser tokens.
	if r.Header.Get("Origin") != "" || token == "" {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	rec, err := h.record(token)
	if err != nil {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if r.URL.Path == StreamPath {
		h.acceptStream(w, r, rec)
		return
	}
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer c.CloseNow()
	c.SetReadLimit(16 << 10)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	first, stop := context.WithTimeout(ctx, operationTimeout)
	var hi hello
	err = readJSON(first, c, &hi)
	stop()
	if err != nil || hi.Protocol != ProtocolVersion || len(hi.Info.Hostname) > 255 || len(hi.Info.DefaultPath) > 4096 || len(hi.Info.Version) > 128 || len(hi.Info.Platform) > 64 || len(hi.Info.Features) > 64 {
		return
	}
	if hi.Info.Features == nil {
		hi.Info.Features = []string{}
	}
	hi.Info.ID = rec.ID
	hi.Info.Name = rec.Name
	hi.Info.Online = true
	l := &link{
		hub:     h,
		record:  rec,
		info:    hi.Info,
		ws:      c,
		ctx:     ctx,
		cancel:  cancel,
		pending: make(map[string]chan *stream),
		slots:   make(chan struct{}, maxStreams),
	}
	h.mu.Lock()
	if h.closed || h.links[rec.ID] != nil {
		h.mu.Unlock()
		_ = c.Close(websocket.StatusPolicyViolation, "Machine already connected")
		return
	}
	h.links[rec.ID] = l
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		if h.links[rec.ID] == l {
			delete(h.links, rec.ID)
		}
		h.mu.Unlock()
	}()
	if err := writeJSON(ctx, c, hello{Protocol: ProtocolVersion, Info: hi.Info}); err != nil {
		return
	}
	go l.monitor(token)
	// Control socket accepts only WebSocket ping/pong after hello.
	_, _, _ = c.Read(ctx)
}

func (l *link) monitor(token string) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	count := 0
	for {
		select {
		case <-l.ctx.Done():
			return
		case <-ticker.C:
			if _, err := l.hub.record(token); err != nil {
				l.cancel()
				l.ws.CloseNow()
				return
			}
			count++
			if count%10 == 0 {
				ctx, cancel := context.WithTimeout(l.ctx, 10*time.Second)
				err := l.ws.Ping(ctx)
				cancel()
				if err != nil {
					l.cancel()
					return
				}
			}
		}
	}
}

func (h *Hub) acceptStream(w http.ResponseWriter, r *http.Request, rec Record) {
	h.mu.Lock()
	l := h.links[rec.ID]
	h.mu.Unlock()
	if l == nil {
		http.Error(w, "Machine offline", http.StatusConflict)
		return
	}
	ticket := r.Header.Get("X-Tmuxde-Ticket")
	l.mu.Lock()
	ch := l.pending[ticket]
	delete(l.pending, ticket)
	l.mu.Unlock()
	if ch == nil {
		http.Error(w, "Invalid stream ticket", http.StatusForbidden)
		return
	}
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	c.SetReadLimit(maxFrame)
	s := &stream{ws: c, done: make(chan struct{})}
	defer s.close()
	select {
	case ch <- s:
	case <-l.ctx.Done():
		return
	case <-time.After(operationTimeout):
		return
	}
	select {
	case <-s.done:
	case <-l.ctx.Done():
	}
}

func (l *link) open(ctx context.Context, kind string) (*stream, error) {
	select {
	case l.slots <- struct{}{}:
	default:
		return nil, errors.New("machine stream limit reached")
	}
	ticket := secret()
	ch := make(chan *stream)
	l.mu.Lock()
	l.pending[ticket] = ch
	l.mu.Unlock()
	defer func() {
		l.mu.Lock()
		delete(l.pending, ticket)
		l.mu.Unlock()
	}()
	if err := writeJSON(ctx, l.ws, invitation{Ticket: ticket, Kind: kind}); err != nil {
		<-l.slots
		return nil, err
	}
	select {
	case s := <-ch:
		go func() {
			<-s.done
			<-l.slots
		}()
		return s, nil
	case <-ctx.Done():
		<-l.slots
		return nil, ctx.Err()
	case <-l.ctx.Done():
		<-l.slots
		return nil, errors.New("machine offline")
	case <-time.After(operationTimeout):
		<-l.slots
		return nil, errors.New("agent stream timeout")
	}
}

func (h *Hub) List() ([]Info, error) {
	records, err := Records(h.Dir)
	if err != nil {
		return nil, err
	}
	infos := []Info{}
	if h.Local != nil {
		infos = append(infos, h.LocalInfo)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, r := range records {
		if r.Revoked {
			continue
		}
		if l := h.links[r.ID]; l != nil && l.record.Hash == r.Hash {
			infos = append(infos, l.info)
		} else {
			infos = append(infos, Info{ID: r.ID, Name: r.Name, Features: []string{}})
		}
	}
	slices.SortFunc(infos, func(a, b Info) int { return strings.Compare(a.Name, b.Name) })
	return infos, nil
}

// Resolve never falls back to another machine for an explicit selection.
func (h *Hub) Resolve(id string) (node.Node, node.FileOpener, Info, <-chan struct{}, error) {
	if id == "" {
		id = "local"
	}
	if id == "local" && h.Local != nil {
		return h.Local, h.LocalFiles, h.LocalInfo, nil, nil
	}
	h.mu.Lock()
	l := h.links[id]
	h.mu.Unlock()
	if l == nil {
		return nil, nil, Info{}, nil, errors.New("machine offline or not found")
	}
	records, err := Records(h.Dir)
	if err != nil {
		return nil, nil, Info{}, nil, err
	}
	if !slices.ContainsFunc(records, func(r Record) bool { return r.ID == id && !r.Revoked && r.Hash == l.record.Hash }) {
		return nil, nil, Info{}, nil, errors.New("machine revoked")
	}
	n := &remote{link: l, conns: make(map[node.ConnID]*stream)}
	return n, n, l.info, l.ctx.Done(), nil
}
