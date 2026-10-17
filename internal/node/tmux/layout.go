package tmux

import (
	"encoding/json"
	"fmt"
	"strings"
)

type layoutCell struct {
	Type     string       `json:"t"`
	Width    int          `json:"w"`
	Height   int          `json:"h"`
	X        int          `json:"x"`
	Y        int          `json:"y"`
	PaneID   string       `json:"I"`
	Index    int          `json:"i"`
	ZIndex   *int         `json:"z"`
	Children []layoutCell `json:"c"`
}

// normalizeLayout keeps tmux 3.8 JSON layouts in the wire format understood by
// existing clients. Active pane and visit order do not change layout geometry.
func normalizeLayout(layout string) string {
	if !strings.HasPrefix(strings.TrimSpace(layout), "{") {
		return layout
	}
	var document struct {
		Version int         `json:"V"`
		Root    *layoutCell `json:"L"`
	}
	if json.Unmarshal([]byte(layout), &document) != nil || document.Version != 2 || document.Root == nil {
		return ""
	}
	var body strings.Builder
	if !document.Root.writeLegacy(&body) {
		return ""
	}
	text := body.String()
	return layoutChecksum(text) + "," + text
}

func (cell layoutCell) writeLegacy(out *strings.Builder) bool {
	// Floating panes have no representation in the existing tiled layout.
	if cell.Width <= 0 || cell.Height <= 0 || cell.X < 0 || cell.Y < 0 || cell.ZIndex != nil {
		return false
	}
	fmt.Fprintf(out, "%dx%d,%d,%d", cell.Width, cell.Height, cell.X, cell.Y)
	if cell.Type == "p" {
		if checkPaneID(cell.PaneID) != nil || len(cell.Children) != 0 {
			return false
		}
		out.WriteByte(',')
		out.WriteString(strings.TrimPrefix(cell.PaneID, "%"))
		return true
	}
	if (cell.Type != "h" && cell.Type != "v") || len(cell.Children) < 2 {
		return false
	}
	open, close := byte('{'), byte('}')
	if cell.Type == "v" {
		open, close = '[', ']'
	}
	out.WriteByte(open)
	for i, child := range cell.Children {
		if i > 0 {
			out.WriteByte(',')
		}
		if !child.writeLegacy(out) {
			return false
		}
	}
	out.WriteByte(close)
	return true
}

// layoutChecksum is tmux's checksum for legacy layout strings.
func layoutChecksum(layout string) string {
	var sum uint16
	for i := 0; i < len(layout); i++ {
		sum = (sum >> 1) | (sum << 15)
		sum += uint16(layout[i])
	}
	return fmt.Sprintf("%04x", sum)
}
