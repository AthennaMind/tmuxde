package protocol

import "errors"

// Shared info structs, ported from ui/src/protocol/types.ts.
// ConnectionState there is browser state only and has no Go twin.

// TerminalSize mirrors TerminalSizeSchema.
type TerminalSize struct {
	Cols int `json:"cols"`
	Rows int `json:"rows"`
}

func (s TerminalSize) Validate() error {
	return errors.Join(
		Between("cols", s.Cols, 1, 1000),
		Between("rows", s.Rows, 1, 500),
	)
}

// SessionInfo mirrors SessionInfoSchema. Created and Activity are ISO
// timestamps as strings.
type SessionInfo struct {
	Name       string        `json:"name"`
	ID         string        `json:"id"`
	Windows    int           `json:"windows"`
	Attached   bool          `json:"attached"`
	Created    string        `json:"created"`
	Activity   string        `json:"activity"`
	Dimensions *TerminalSize `json:"dimensions,omitempty"`
}

func (s SessionInfo) Validate() error {
	if s.Dimensions == nil {
		return nil
	}
	return Nested("dimensions", s.Dimensions)
}

// Position is the pane offset inside its window, in cells.
type Position struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

// PaneInfo mirrors PaneInfoSchema.
type PaneInfo struct {
	ID         string       `json:"id"`
	Index      int          `json:"index"`
	WindowID   string       `json:"windowId"`
	Active     bool         `json:"active"`
	Zoomed     bool         `json:"zoomed"`
	Dimensions TerminalSize `json:"dimensions"`
	Position   Position     `json:"position"`
	Command    *string      `json:"command,omitempty"`
	Path       *string      `json:"path,omitempty"`
}

func (p PaneInfo) Validate() error {
	return Nested("dimensions", p.Dimensions)
}

// WindowInfo mirrors WindowInfoSchema. Activity is tmux
// window_activity_flag and Zoomed is window_zoomed_flag. Both are optional
// so an absent value reads as "cannot say".
type WindowInfo struct {
	ID         string        `json:"id"`
	Index      int           `json:"index"`
	Name       string        `json:"name"`
	Active     bool          `json:"active"`
	PaneCount  int           `json:"paneCount"`
	Layout     string        `json:"layout"`
	Activity   *bool         `json:"activity,omitempty"`
	Zoomed     *bool         `json:"zoomed,omitempty"`
	Dimensions *TerminalSize `json:"dimensions,omitempty"`
}

func (w WindowInfo) Validate() error {
	if w.Dimensions == nil {
		return nil
	}
	return Nested("dimensions", w.Dimensions)
}

// FileTypes are the values of FileEntry.Type and FileStat.Type.
var FileTypes = []string{"file", "directory", "symlink", "other"}

// FileEntry mirrors FileEntrySchema.
type FileEntry struct {
	Name     string  `json:"name"`
	Path     string  `json:"path"`
	Type     string  `json:"type"`
	Size     float64 `json:"size"`
	Modified string  `json:"modified"`
}

func (f FileEntry) Validate() error {
	return OneOf("type", f.Type, FileTypes...)
}

// FileStat mirrors FileStatSchema.
type FileStat struct {
	Name        string  `json:"name"`
	Path        string  `json:"path"`
	Type        string  `json:"type"`
	Size        float64 `json:"size"`
	Modified    string  `json:"modified"`
	Created     string  `json:"created"`
	Permissions string  `json:"permissions"`
	IsReadable  bool    `json:"isReadable"`
	IsWritable  bool    `json:"isWritable"`
}

func (f FileStat) Validate() error {
	return OneOf("type", f.Type, FileTypes...)
}
