package ws

import (
	"bufio"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// clientAddr is the address caps, throttle and the access log key on.
//
// It is the host of the TCP peer. When the server listens on a unix socket
// or the peer is loopback, the peer is treated as a local proxy, and the
// first X-Forwarded-For entry names the browser. A direct client on the
// LAN could write that header too, so from any other peer it is ignored.
// An entry that is not an IP address is ignored as well.
//
// A unix socket peer without the header has no address and gives "". The
// registry counts that as conns.UnknownAddr.
func clientAddr(r *http.Request) string {
	unix := isUnixListener(r)
	peer := ""
	if !unix {
		peer = r.RemoteAddr
		if host, _, err := net.SplitHostPort(peer); err == nil {
			peer = host
		}
	}
	if unix || isLoopback(peer) {
		if fwd, ok := firstForwarded(r.Header.Values("X-Forwarded-For")); ok {
			return fwd
		}
	}
	return peer
}

// isUnixListener reports whether the request came in on a unix socket.
func isUnixListener(r *http.Request) bool {
	addr, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr)
	return ok && addr != nil && (addr.Network() == "unix" || addr.Network() == "unixpacket")
}

func isLoopback(host string) bool {
	ip, err := netip.ParseAddr(host)
	return err == nil && ip.Unmap().IsLoopback()
}

// firstForwarded returns the first entry of X-Forwarded-For when it is an
// IP address, with or without a port.
func firstForwarded(values []string) (string, bool) {
	if len(values) == 0 {
		return "", false
	}
	first, _, _ := strings.Cut(values[0], ",")
	first = strings.TrimSpace(first)
	if ap, err := netip.ParseAddrPort(first); err == nil {
		return ap.Addr().String(), true
	}
	first = strings.TrimSuffix(strings.TrimPrefix(first, "["), "]")
	if ip, err := netip.ParseAddr(first); err == nil {
		return ip.String(), true
	}
	return "", false
}

// hijackWriter keeps the connection that websocket.Accept hijacks. Closing
// it drops a socket at once, where a close handshake could wait seconds
// for a peer that never answers.
type hijackWriter struct {
	http.ResponseWriter
	conn net.Conn
}

func (w *hijackWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, rw, err := http.NewResponseController(w.ResponseWriter).Hijack()
	if err == nil {
		w.conn = conn
	}
	return conn, rw, err
}

func (w *hijackWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}
