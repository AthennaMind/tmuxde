package filehttp

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"time"
)

// TicketPath answers POST with a ticket for one file. A media element
// cannot send the bearer header, so <video>, <audio> and a PDF frame load
// /file with the ticket in the query instead. A ticket names one machine
// and path and expires after TicketTTL, so a copy in a proxy log opens
// one file for a few minutes, never the hub.
const TicketPath = Path + "/ticket"

// TicketTTL is how long a ticket opens its file. Playback that outlives it
// gets a network error, and the browser asks for a new ticket.
const TicketTTL = 15 * time.Minute

// ticketBodyLimit caps the request body. A path is never that long.
const ticketBodyLimit = 64 << 10

// ticketBytes is the decoded size: 8 bytes of expiry and a SHA-256 MAC.
const ticketBytes = 8 + sha256.Size

// Bodies of the ticket route.
const (
	bodyMethod     = "Method not allowed"
	bodyBadRequest = "Invalid request"
)

type ticketRequest struct {
	Path string `json:"path"`
	// Machine is the id the /file request will carry. Empty means local.
	Machine string `json:"machine"`
}

// ticketResponse is the JSON answer. ExpiresIn is in seconds, so the
// browser clock does not matter.
type ticketResponse struct {
	Ticket    string `json:"ticket"`
	ExpiresIn int64  `json:"expiresIn"`
}

// newTicketKey draws the signing key. It lives as long as the process, so
// a restart voids every ticket and the browser asks for a new one.
func newTicketKey() []byte {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		panic("filehttp: ticket key: " + err.Error())
	}
	return key
}

// ticket serves POST /file/ticket. Only the bearer header authorizes it.
// A ticket cannot mint another, and neither can the deprecated query token.
func (h *handler) ticket(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		writeText(w, http.StatusMethodNotAllowed, bodyMethod)
		return
	}
	bearer, ok := bearerToken(r)
	if !ok || !h.tokenOK(bearer) {
		writeText(w, http.StatusUnauthorized, bodyUnauthorized)
		return
	}
	var req ticketRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, ticketBodyLimit)).Decode(&req); err != nil {
		writeText(w, http.StatusBadRequest, bodyBadRequest)
		return
	}
	if req.Path == "" {
		writeText(w, http.StatusBadRequest, bodyMissingPath)
		return
	}
	hdr := w.Header()
	hdr.Set("Content-Type", "application/json")
	hdr.Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(ticketResponse{
		Ticket:    h.mint(h.now().Add(TicketTTL), req.Machine, req.Path),
		ExpiresIn: int64(TicketTTL / time.Second),
	})
}

// mint signs an expiry for one machine and path.
func (h *handler) mint(exp time.Time, machine, path string) string {
	buf := make([]byte, ticketBytes)
	binary.BigEndian.PutUint64(buf[:8], uint64(exp.Unix()))
	copy(buf[8:], h.sign(buf[:8], machine, path))
	return base64.RawURLEncoding.EncodeToString(buf)
}

// sign is the MAC over expiry, machine and path. A NUL separates the two
// names. Machine ids are alphanumeric, so the split is unambiguous.
func (h *handler) sign(exp []byte, machine, path string) []byte {
	mac := hmac.New(sha256.New, h.ticketKey)
	mac.Write(exp)
	mac.Write([]byte(machine))
	mac.Write([]byte{0})
	mac.Write([]byte(path))
	return mac.Sum(nil)
}

// ticketOK reports whether ticket opens path on machine now.
func (h *handler) ticketOK(ticket, machine, path string) bool {
	raw, err := base64.RawURLEncoding.DecodeString(ticket)
	if err != nil || len(raw) != ticketBytes {
		return false
	}
	if !hmac.Equal(raw[8:], h.sign(raw[:8], machine, path)) {
		return false
	}
	exp := time.Unix(int64(binary.BigEndian.Uint64(raw[:8])), 0)
	return h.now().Before(exp)
}
