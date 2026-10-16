package protocol

import (
	"errors"
	"regexp"
)

var previewPaneID = regexp.MustCompile(`^%[0-9]+$`)

// PreviewTarget scopes a pane to its listed session without attaching it.
type PreviewTarget struct {
	Session string `json:"session"`
	PaneID  string `json:"paneId"`
}

func (p PreviewTarget) Validate() error {
	return errors.Join(LengthBetween("session", p.Session, 1, 256), Pattern("paneId", p.PaneID, previewPaneID))
}

type PreviewFrame struct {
	PaneID      string `json:"paneId"`
	Cols        int    `json:"cols"`
	Rows        int    `json:"rows"`
	Content     string `json:"content"`
	Unavailable bool   `json:"unavailable"`
}

func (p PreviewFrame) Validate() error {
	return errors.Join(Pattern("paneId", p.PaneID, previewPaneID), Between("cols", p.Cols, 1, 1000), Between("rows", p.Rows, 1, 500), MaxLength("content", p.Content, 131072))
}
