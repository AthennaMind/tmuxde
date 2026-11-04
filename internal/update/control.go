package update

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

type controlInfo struct {
	Binary string `json:"binary"`
	PID    int    `json:"pid"`
	Reason string `json:"reason"`
}

type applyRequest struct {
	ID string `json:"id"`
}

func controlRequest(ctx context.Context, socket, path, id string, result any) error {
	if !filepath.IsAbs(socket) {
		return errors.New("native supervisor is unavailable")
	}
	if err := validateDirectory(filepath.Dir(socket)); err != nil {
		return errors.New("native supervisor socket is not private")
	}
	info, err := os.Lstat(socket)
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		return errors.New("native supervisor is unavailable")
	}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, Timeout: 10 * time.Second}
	method := http.MethodGet
	var body io.Reader
	if id != "" {
		method = http.MethodPost
		data, err := json.Marshal(applyRequest{ID: id})
		if err != nil {
			return err
		}
		body = bytes.NewReader(data)
	}
	request, err := http.NewRequestWithContext(ctx, method, "http://localhost"+path, body)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return errors.New("native supervisor is unavailable")
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 16<<10))
	if err != nil {
		return err
	}
	if response.StatusCode != http.StatusOK {
		return errors.New(string(bytes.TrimSpace(data)))
	}
	if result != nil {
		return json.Unmarshal(data, result)
	}
	return nil
}

func (s *supervisor) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/info":
		s.mu.Lock()
		defer s.mu.Unlock()
		info := controlInfo{Binary: s.binary, Reason: s.reason}
		if s.child != nil {
			info.PID = s.child.command.Process.Pid
		}
		if info.Reason == "" && s.pending == "" {
			guard, err := transactionLock(s.dir)
			if err != nil {
				info.Reason = err.Error()
			} else {
				if err := s.exclusive(); err != nil {
					info.Reason = err.Error()
				} else {
					s.shared()
				}
				guard.Close()
			}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(info)
	case r.Method == http.MethodPost && r.URL.Path == "/apply":
		var request applyRequest
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&request); err != nil || !identifier.MatchString(request.ID) {
			http.Error(w, "invalid update transaction", http.StatusBadRequest)
			return
		}
		if err := decoder.Decode(new(any)); err != io.EOF {
			http.Error(w, "invalid update transaction", http.StatusBadRequest)
			return
		}
		if err := s.prepare(request.ID); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		w.WriteHeader(http.StatusOK)
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		s.requests <- request.ID
	default:
		http.NotFound(w, r)
	}
}
