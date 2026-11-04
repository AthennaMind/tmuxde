// Package updates serves authenticated manual update operations.
package updates

import (
	"encoding/json"
	"io"
	"net/http"
	"slices"
	"strings"

	"tmuxde/internal/hub/auth"
	"tmuxde/internal/update"
)

type Handler struct {
	Token   string
	Origins []string
	Manager *update.Manager
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || token == "" || h.Token == "" || !auth.TokenEqual(token, h.Token) {
		http.Error(w, "Unauthorized", http.StatusUnauthorized)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && len(h.Origins) > 0 && !slices.Contains(h.Origins, origin) {
		http.Error(w, "Forbidden origin", http.StatusForbidden)
		return
	}
	switch {
	case r.URL.Path == "/updates" && r.Method == http.MethodGet:
		h.reply(w, h.Manager.Status(r.Context()))
	case r.URL.Path == "/updates/check" && r.Method == http.MethodPost:
		if err := h.Manager.Check(r.Context()); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		h.reply(w, h.Manager.Status(r.Context()))
	case r.URL.Path == "/updates/jobs" && r.Method == http.MethodPost:
		var request update.StartRequest
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&request); err != nil {
			http.Error(w, "Invalid update request", http.StatusBadRequest)
			return
		}
		if err := decoder.Decode(new(any)); err != io.EOF {
			http.Error(w, "Invalid update request", http.StatusBadRequest)
			return
		}
		job, err := h.Manager.Start(r.Context(), request)
		if err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		h.reply(w, job)
	case strings.HasPrefix(r.URL.Path, "/updates/jobs/"):
		id := strings.TrimPrefix(r.URL.Path, "/updates/jobs/")
		if r.Method == http.MethodPost && strings.HasSuffix(id, "/cancel") {
			if err := h.Manager.Cancel(r.Context(), strings.TrimSuffix(id, "/cancel")); err != nil {
				http.Error(w, err.Error(), http.StatusConflict)
				return
			}
			h.reply(w, h.Manager.Status(r.Context()))
			return
		}
		state := h.Manager.Status(r.Context())
		if r.Method != http.MethodGet || state.Job == nil || state.Job.ID != id {
			http.NotFound(w, r)
			return
		}
		h.reply(w, state.Job)
	default:
		http.NotFound(w, r)
	}
}

func (h *Handler) reply(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
