package machine

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"tmuxde/internal/node"
	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

type remote struct {
	link  *link
	mu    sync.Mutex
	conns map[node.ConnID]*stream
}

func (n *remote) Open(ctx context.Context, id node.ConnID, out node.Sink) error {
	s, err := n.link.open(ctx, "node")
	if err != nil {
		return err
	}
	n.mu.Lock()
	if n.conns[id] != nil {
		n.mu.Unlock()
		s.close()
		return errors.New("connection already open")
	}
	n.conns[id] = s
	n.mu.Unlock()
	go func() {
		select {
		case <-ctx.Done():
			s.close()
		case <-s.done:
		}
	}()
	go func() {
		defer s.close()
		for {
			typ, b, err := s.ws.Read(ctx)
			if err != nil {
				return
			}
			if typ != websocket.MessageText {
				return
			}
			m, err := server.Decode(b)
			if err != nil {
				return
			}
			kind := m.WireType()
			if strings.HasPrefix(kind, "auth:") || strings.HasPrefix(kind, "dictation:") || kind == "server:info" || kind == "pong" {
				return
			}
			if err := out.Send(ctx, m); err != nil {
				return
			}
		}
	}()
	return nil
}

func (n *remote) Handle(ctx context.Context, id node.ConnID, msg client.Message) error {
	n.mu.Lock()
	s := n.conns[id]
	n.mu.Unlock()
	if s == nil {
		return errors.New("connection not open")
	}
	b, err := protocol.Encode(msg)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()
	return s.ws.Write(ctx, websocket.MessageText, b)
}

func (n *remote) Close(id node.ConnID) {
	n.mu.Lock()
	s := n.conns[id]
	delete(n.conns, id)
	n.mu.Unlock()
	if s != nil {
		s.close()
	}
}

func (n *remote) Done(id node.ConnID) <-chan struct{} {
	n.mu.Lock()
	defer n.mu.Unlock()
	if s := n.conns[id]; s != nil {
		return s.done
	}
	done := make(chan struct{})
	close(done)
	return done
}

func (n *remote) OpenFile(ctx context.Context, path string) (node.File, error) {
	s, err := n.link.open(ctx, "file")
	if err != nil {
		return nil, err
	}
	ok := false
	defer func() {
		if !ok {
			s.close()
		}
	}()
	stop := context.AfterFunc(ctx, s.close)
	defer func() {
		if !ok {
			stop()
		}
	}()
	if err := writeJSON(ctx, s.ws, fileRequest{Path: path}); err != nil {
		return nil, err
	}
	var reply fileReply
	readCtx, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()
	if err := readJSON(readCtx, s.ws, &reply); err != nil {
		return nil, err
	}
	switch reply.Error {
	case "":
	case "denied":
		return nil, node.ErrDenied
	case "not-file":
		return nil, node.ErrNotFile
	default:
		return nil, node.ErrNotFound
	}
	if reply.Size < 0 {
		return nil, node.ErrNotFile
	}
	ok = true
	return &remoteFile{stream: s, ctx: ctx, info: reply, stop: stop}, nil
}

type remoteFile struct {
	stream *stream
	ctx    context.Context
	info   fileReply
	offset int64
	stop   func() bool
}

func (f *remoteFile) Close() error {
	f.stop()
	f.stream.close()
	return nil
}

func (f *remoteFile) Stat() (fs.FileInfo, error) { return remoteInfo{f.info}, nil }

func (f *remoteFile) Seek(offset int64, whence int) (int64, error) {
	base := int64(0)
	switch whence {
	case io.SeekStart:
	case io.SeekCurrent:
		base = f.offset
	case io.SeekEnd:
		base = f.info.Size
	default:
		return 0, errors.New("invalid seek")
	}
	next := base + offset
	if next < 0 || (offset > 0 && next < base) {
		return 0, errors.New("invalid offset")
	}
	f.offset = next
	return next, nil
}

func (f *remoteFile) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if f.offset >= f.info.Size {
		return 0, io.EOF
	}
	length := min(len(p), chunkSize)
	if err := writeJSON(f.ctx, f.stream.ws, fileRequest{Offset: f.offset, Length: length}); err != nil {
		return 0, err
	}
	ctx, cancel := context.WithTimeout(f.ctx, operationTimeout)
	defer cancel()
	typ, b, err := f.stream.ws.Read(ctx)
	if err != nil {
		return 0, err
	}
	if typ != websocket.MessageBinary || len(b) > length {
		return 0, errors.New("invalid file chunk")
	}
	if len(b) == 0 {
		return 0, io.EOF
	}
	n := copy(p, b)
	f.offset += int64(n)
	return n, nil
}

type remoteInfo struct{ fileReply }

func (i remoteInfo) Name() string { return i.fileReply.Name }

func (i remoteInfo) Size() int64 { return i.fileReply.Size }

func (i remoteInfo) Mode() fs.FileMode { return 0600 }

func (i remoteInfo) ModTime() time.Time { return i.Modified }

func (i remoteInfo) IsDir() bool { return false }

func (i remoteInfo) Sys() any { return nil }
