package machine

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/coder/websocket"
)

const ProtocolVersion = 1
const AgentPath = "/_agent"
const StreamPath = "/_agent/stream"
const MachinesPath = "/machines"
const maxFrame = 2 << 20
const chunkSize = 64 << 10
const maxStreams = 64
const operationTimeout = 15 * time.Second

// hello negotiates protocol before accepting any machine operations.
type hello struct {
	Protocol int  `json:"protocol"`
	Info     Info `json:"info"`
}
type invitation struct {
	Ticket string `json:"ticket"`
	Kind   string `json:"kind"`
}
type fileRequest struct {
	Path   string `json:"path,omitempty"`
	Offset int64  `json:"offset,omitempty"`
	Length int    `json:"length,omitempty"`
}
type fileReply struct {
	Name     string    `json:"name,omitempty"`
	Size     int64     `json:"size,omitempty"`
	Modified time.Time `json:"modified,omitempty"`
	Error    string    `json:"error,omitempty"`
}

func writeJSON(ctx context.Context, c *websocket.Conn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, operationTimeout)
	defer cancel()
	return c.Write(ctx, websocket.MessageText, b)
}

func readJSON(ctx context.Context, c *websocket.Conn, v any) error {
	typ, b, err := c.Read(ctx)
	if err != nil {
		return err
	}
	if typ != websocket.MessageText {
		return errors.New("expected text frame")
	}
	return json.Unmarshal(b, v)
}
