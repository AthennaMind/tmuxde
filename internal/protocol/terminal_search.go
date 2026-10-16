package protocol

// TerminalSearchMatch is a plain text excerpt of one logical history line.
type TerminalSearchMatch struct {
	SessionName string `json:"sessionName"`
	WindowID    string `json:"windowId"`
	PaneID      string `json:"paneId"`
	Command     string `json:"command"`
	Path        string `json:"path"`
	Line        int    `json:"line"`
	Text        string `json:"text"`
	Before      string `json:"before"`
	After       string `json:"after"`
}

func (m TerminalSearchMatch) Validate() error {
	return Min("line", m.Line, 1)
}
