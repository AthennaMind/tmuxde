package update

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"sync"
	"time"
)

// Speech discovers its native supervisor through configured private Unix socket.
type Speech struct {
	mu     sync.Mutex
	Host   Host
	Socket string
}

func (s *Speech) host(ctx context.Context) (Host, error) {
	s.mu.Lock()
	host := s.Host
	s.mu.Unlock()
	host.Component.Online = false
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", s.Socket)
		},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 2 * time.Second}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://localhost/health", nil)
	if err != nil {
		return host, err
	}
	response, err := client.Do(request)
	if err != nil {
		return host, errors.New("Speech service unavailable")
	}
	defer response.Body.Close()
	var health struct {
		OK            bool   `json:"ok"`
		Version       string `json:"version"`
		Sessions      int    `json:"sessions"`
		UpdateControl string `json:"updateControl"`
		Binary        string `json:"binary"`
		PID           int    `json:"pid"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(http.MaxBytesReader(nil, response.Body, 16<<10)).Decode(&health) != nil || !health.OK {
		return host, errors.New("Speech service unavailable")
	}
	host.Component.Version = health.Version
	host.Component.Online = true
	host.Control = health.UpdateControl
	host.Binary = health.Binary
	host.PID = health.PID
	s.mu.Lock()
	s.Host = host
	s.mu.Unlock()
	if health.Version == "" {
		return host, errors.New("manual speech upgrade required to enable updates")
	}
	if health.Sessions > 0 {
		return host, errors.New("finish active dictation before updating speech")
	}
	return host, nil
}

func (s *Speech) Info(ctx context.Context) Component {
	host, err := s.host(ctx)
	if inContainer() {
		info := host.Component
		info.Reason = "Managed by Docker"
		return info
	}
	if err != nil {
		info := host.Component
		info.Reason = err.Error()
		return info
	}
	return host.Info(ctx)
}

func (s *Speech) Stage(ctx context.Context, id string, p Package) error {
	host, err := s.host(ctx)
	if err != nil {
		return err
	}
	return host.Stage(ctx, id, p)
}

func (s *Speech) Apply(ctx context.Context, id string) error {
	host, err := s.host(ctx)
	if err != nil {
		return err
	}
	return host.Apply(ctx, id)
}

func (s *Speech) Status(ctx context.Context, id string) (Result, error) {
	host, err := s.lastHost(ctx)
	if err != nil {
		return Result{}, err
	}
	return host.Status(ctx, id)
}

func (s *Speech) Cancel(ctx context.Context, id string) error {
	host, err := s.lastHost(ctx)
	if err != nil {
		return err
	}
	return host.Cancel(ctx, id)
}

func (s *Speech) lastHost(ctx context.Context) (Host, error) {
	s.mu.Lock()
	host := s.Host
	s.mu.Unlock()
	if host.Binary != "" {
		return host, nil
	}
	return s.host(ctx)
}
