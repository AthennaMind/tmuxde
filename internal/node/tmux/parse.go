package tmux

import (
	"strings"
	"time"

	"tmuxde/internal/protocol"
)

// Format strings, byte for byte as the relay sent them.
const (
	sessionFormat  = "#{session_name}\t#{session_id}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}\t#{window_width}\t#{window_height}"
	createFormat   = "#{session_name}\t#{session_id}"
	nameFormat     = "#{session_name}"
	windowFormat   = "#{window_id}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}\t#{window_layout}\t#{window_width}\t#{window_height}\t#{window_activity_flag}\t#{window_zoomed_flag}"
	paneFormat     = "#{pane_id}\t#{pane_index}\t#{window_id}\t#{pane_active}\t#{window_zoomed_flag}\t#{pane_width}\t#{pane_height}\t#{pane_left}\t#{pane_top}\t#{pane_current_command}\t#{pane_current_path}"
	scrollFormat   = "#{pane_id}\t#{pane_in_mode}\t#{scroll_position}\t#{history_size}\t#{pane_height}\t#{pane_width}\t#{alternate_on}\t#{mouse_any_flag}\t#{mouse_sgr_flag}\t#{mouse_utf8_flag}"
	zoomFormat     = "#{window_zoomed_flag}\t#{pane_active}"
	windowIDFormat = "#{window_id}"
)

// Field counts of the list formats.
const (
	sessionFields = 8
	windowFields  = 10
	paneFields    = 11
	scrollFields  = 10
)

// lines splits list output into its non empty lines. Fields are not
// trimmed. A session name may start or end with a space.
func lines(out string) []string {
	var res []string
	for _, l := range strings.Split(out, "\n") {
		if l != "" {
			res = append(res, l)
		}
	}
	return res
}

// fields splits one line into n tab separated fields. The last field keeps
// any further tabs, so a path with a tab in it survives. A shorter line is
// refused. It can only be the tail of a free text field that held a
// newline.
func fields(line string, n int) ([]string, bool) {
	f := strings.SplitN(line, "\t", n)
	return f, len(f) == n
}

// atoi reads an int the way JavaScript parseInt(s, 10) does: optional
// spaces and sign, then leading digits. No digits reads as 0, where
// parseInt gave NaN.
func atoi(s string) int {
	s = strings.TrimLeft(s, " \t\n\r\v\f")
	neg := false
	if s != "" && (s[0] == '-' || s[0] == '+') {
		neg = s[0] == '-'
		s = s[1:]
	}
	n := 0
	for i := 0; i < len(s) && s[i] >= '0' && s[i] <= '9'; i++ {
		n = n*10 + int(s[i]-'0')
	}
	if neg {
		return -n
	}
	return n
}

// count is atoi that reads anything not above 0 as 0, as num() did in
// readScrollTarget.
func count(s string) int {
	return max(atoi(s), 0)
}

// isoTime formats like JavaScript Date.toISOString: UTC, milliseconds, Z.
func isoTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// epochISO turns tmux epoch seconds into an ISO timestamp.
func epochISO(s string) string {
	return isoTime(time.Unix(int64(atoi(s)), 0))
}

// dimensions is set only when both values are present.
func dimensions(width, height string) *protocol.TerminalSize {
	if width == "" || height == "" {
		return nil
	}
	return &protocol.TerminalSize{Cols: atoi(width), Rows: atoi(height)}
}

func optional(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func flag(s string) *bool {
	b := s == "1"
	return &b
}

func parseSessions(out string) []protocol.SessionInfo {
	res := []protocol.SessionInfo{}
	for _, l := range lines(out) {
		f, ok := fields(l, sessionFields)
		if !ok {
			continue
		}
		res = append(res, protocol.SessionInfo{
			Name:       f[0],
			ID:         f[1],
			Windows:    atoi(f[2]),
			Attached:   f[3] == "1",
			Created:    epochISO(f[4]),
			Activity:   epochISO(f[5]),
			Dimensions: dimensions(f[6], f[7]),
		})
	}
	return res
}

func parseNames(out string) []string {
	return append([]string{}, lines(out)...)
}

func parseWindows(out string) []protocol.WindowInfo {
	res := []protocol.WindowInfo{}
	for _, l := range lines(out) {
		f, ok := fields(l, windowFields)
		if !ok {
			continue
		}
		res = append(res, protocol.WindowInfo{
			ID:        f[0],
			Index:     atoi(f[1]),
			Name:      f[2],
			Active:    f[3] == "1",
			PaneCount: atoi(f[4]),
			Layout:    normalizeLayout(f[5]),
			Activity:  flag(f[8]),
			// window_layout is the same zoomed and unzoomed. tmux reports
			// the layout the window goes back to. This flag is the only
			// field that moves on prefix z in another terminal, and the
			// only thing a poller can notice it by.
			Zoomed:     flag(f[9]),
			Dimensions: dimensions(f[6], f[7]),
		})
	}
	return res
}

func parsePanes(out string) []protocol.PaneInfo {
	res := []protocol.PaneInfo{}
	for _, l := range lines(out) {
		f, ok := fields(l, paneFields)
		if !ok {
			continue
		}
		active := f[3] == "1"
		res = append(res, protocol.PaneInfo{
			ID:       f[0],
			Index:    atoi(f[1]),
			WindowID: f[2],
			Active:   active,
			// window_zoomed_flag belongs to the window. Every pane of a
			// zoomed window reports it. The pane that fills the window is
			// the active one, so both must hold.
			Zoomed:     f[4] == "1" && active,
			Dimensions: protocol.TerminalSize{Cols: atoi(f[5]), Rows: atoi(f[6])},
			Position:   protocol.Position{X: float64(atoi(f[7])), Y: float64(atoi(f[8]))},
			Command:    optional(f[9]),
			Path:       optional(f[10]),
		})
	}
	return res
}

// parseCreated reads the name and id new-session printed.
func parseCreated(out string) (name, id string) {
	name, id, _ = strings.Cut(strings.TrimRight(out, "\n"), "\t")
	return name, id
}

// parseZoom reads zoomFormat. The pane counts as zoomed when its window is
// zoomed and it is the active pane, the same reading parsePanes uses.
func parseZoom(out string) (windowZoomed, paneZoomed bool) {
	flagValue, active, _ := strings.Cut(strings.TrimRight(out, "\n"), "\t")
	windowZoomed = flagValue == "1"
	return windowZoomed, windowZoomed && active == "1"
}

// parseScrollState reads scrollFormat. fallback is the target asked for. It
// becomes Pane when tmux printed no pane id.
func parseScrollState(out, fallback string) ScrollState {
	f := strings.Split(strings.TrimRight(out, "\n"), "\t")
	for len(f) < scrollFields {
		f = append(f, "")
	}
	inMode := f[1] == "1"
	app := !inMode && (f[6] == "1" || f[7] == "1")
	st := ScrollState{
		Pane:        f[0],
		InMode:      inMode,
		Position:    count(f[2]),
		HistorySize: count(f[3]),
		PaneHeight:  count(f[4]),
		Width:       count(f[5]),
		Application: app,
		Mouse:       f[7] == "1",
		SGR:         f[8] == "1",
		UTF8:        f[9] == "1",
	}
	if st.Pane == "" {
		st.Pane = fallback
	}
	if app {
		// The shell history rail means nothing inside an application.
		st.HistorySize = 0
	}
	return st
}

// hasZFlag reports whether a list-commands usage line offers -Z, as the
// relay's /-[A-Za-z]*Z/ did: a dash, then letters up to a Z.
func hasZFlag(usage string) bool {
	for i := 0; i < len(usage); i++ {
		if usage[i] != '-' {
			continue
		}
		for j := i + 1; j < len(usage) && isLetter(usage[j]); j++ {
			if usage[j] == 'Z' {
				return true
			}
		}
	}
	return false
}

func isLetter(b byte) bool {
	return b >= 'a' && b <= 'z' || b >= 'A' && b <= 'Z'
}
