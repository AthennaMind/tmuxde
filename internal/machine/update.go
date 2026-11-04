package machine

import (
	"context"
	"errors"
	"io"
	"os"
	"slices"
	"time"

	"github.com/coder/websocket"

	"tmuxde/internal/update"
)

type updateRequest struct {
	Operation string         `json:"operation"`
	ID        string         `json:"id"`
	Package   update.Package `json:"package"`
}

type updateReply struct {
	Error    string        `json:"error"`
	Result   update.Result `json:"result"`
	NotFound bool          `json:"notFound,omitempty"`
}

type updateTarget struct {
	hub  *Hub
	id   string
	name string
}

// UpdateTargets includes old and offline agents so Settings explains each one.
func (h *Hub) UpdateTargets() []update.Target {
	infos, err := h.List()
	if err != nil {
		return nil
	}
	targets := []update.Target{}
	for _, info := range infos {
		if info.ID != "local" {
			targets = append(targets, &updateTarget{hub: h, id: info.ID, name: info.Name})
		}
	}
	return targets
}

func (t *updateTarget) Info(_ context.Context) update.Component {
	t.hub.mu.Lock()
	defer t.hub.mu.Unlock()
	info := update.Component{
		ID:     t.id,
		Name:   t.name,
		Kind:   "agent",
		Reason: "Agent offline",
	}
	if link := t.hub.links[t.id]; link != nil {
		info.Name = link.info.Name
		info.Version = link.info.Version
		info.OS = link.info.Platform
		info.Online = true
		info.Reason = "Manual upgrade required to enable updates"
		if link.info.Update != nil && slices.Contains(link.info.Features, update.Feature) {
			info.Arch = link.info.Update.Arch
			info.Reason = link.info.Update.Reason
		}
	}
	return info
}

func (t *updateTarget) request(ctx context.Context, request updateRequest) (update.Result, error) {
	timeout := 30 * time.Second
	if request.Operation == "stage" {
		timeout = 20 * time.Minute
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	t.hub.mu.Lock()
	link := t.hub.links[t.id]
	t.hub.mu.Unlock()
	if link == nil || !slices.Contains(link.info.Features, update.Feature) {
		return update.Result{}, errors.New("agent is unavailable for updates")
	}
	stream, err := link.open(ctx, "update")
	if err != nil {
		return update.Result{}, err
	}
	defer stream.close()
	if err := writeJSON(ctx, stream.ws, request); err != nil {
		return update.Result{}, err
	}
	var reply updateReply
	if err := readJSON(ctx, stream.ws, &reply); err != nil {
		return update.Result{}, err
	}
	if reply.Error != "" {
		if reply.NotFound {
			return reply.Result, os.ErrNotExist
		}
		return reply.Result, errors.New(reply.Error)
	}
	if request.Operation == "stage" {
		archive, err := os.Open(request.Package.Archive)
		if err != nil {
			return update.Result{}, err
		}
		defer archive.Close()
		buffer := make([]byte, chunkSize)
		for {
			n, err := archive.Read(buffer)
			if n > 0 {
				writeCtx, cancel := context.WithTimeout(ctx, operationTimeout)
				writeErr := stream.ws.Write(writeCtx, websocket.MessageBinary, buffer[:n])
				cancel()
				if writeErr != nil {
					return update.Result{}, writeErr
				}
			}
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return update.Result{}, err
			}
		}
		if err := readJSON(ctx, stream.ws, &reply); err != nil {
			return update.Result{}, err
		}
	}
	if reply.Error != "" {
		return reply.Result, errors.New(reply.Error)
	}
	return reply.Result, nil
}

func (t *updateTarget) Stage(ctx context.Context, id string, pkg update.Package) error {
	_, err := t.request(ctx, updateRequest{Operation: "stage", ID: id, Package: pkg})
	return err
}

func (t *updateTarget) Apply(ctx context.Context, id string) error {
	_, err := t.request(ctx, updateRequest{Operation: "apply", ID: id})
	return err
}

func (t *updateTarget) Status(ctx context.Context, id string) (update.Result, error) {
	return t.request(ctx, updateRequest{Operation: "status", ID: id})
}

func (t *updateTarget) Cancel(ctx context.Context, id string) error {
	_, err := t.request(ctx, updateRequest{Operation: "cancel", ID: id})
	return err
}

func (a *Agent) serveUpdate(ctx context.Context, c *websocket.Conn) {
	if a.Updater == nil {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()
	c.SetReadLimit(8 << 20)
	var request updateRequest
	if err := readJSON(ctx, c, &request); err != nil {
		return
	}
	reply := updateReply{}
	var err error
	switch request.Operation {
	case "stage":
		if request.Package.Asset.Size <= 0 || request.Package.Asset.Size > 1<<30 {
			err = errors.New("invalid update archive size")
			break
		}
		if err = update.Verify(request.Package); err != nil {
			break
		}
		archive, createErr := os.CreateTemp("", "tmuxde-update-*")
		if createErr != nil {
			err = createErr
			break
		}
		defer os.Remove(archive.Name())
		defer archive.Close()
		if err := writeJSON(ctx, c, reply); err != nil {
			return
		}
		c.SetReadLimit(chunkSize)
		remaining := request.Package.Asset.Size
		for remaining > 0 {
			readCtx, stop := context.WithTimeout(ctx, operationTimeout)
			typ, bytes, readErr := c.Read(readCtx)
			stop()
			if readErr != nil || typ != websocket.MessageBinary || len(bytes) == 0 || int64(len(bytes)) > remaining {
				return
			}
			if _, err := archive.Write(bytes); err != nil {
				return
			}
			remaining -= int64(len(bytes))
		}
		request.Package.Archive = archive.Name()
		err = a.Updater.Stage(ctx, request.ID, request.Package)
	case "apply":
		err = a.Updater.Apply(ctx, request.ID)
	case "status":
		reply.Result, err = a.Updater.Status(ctx, request.ID)
	case "cancel":
		err = a.Updater.Cancel(ctx, request.ID)
	default:
		err = errors.New("unknown update operation")
	}
	if err != nil {
		reply.Error = err.Error()
		reply.NotFound = errors.Is(err, os.ErrNotExist)
	}
	_ = writeJSON(ctx, c, reply)
}
