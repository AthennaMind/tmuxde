package protocol

import "regexp"

var fileRevisionPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// FileRevision validates a SHA-256 digest of the file bytes.
func FileRevision(field, value string) error {
	return Pattern(field, value, fileRevisionPattern)
}

// FileDocument is a complete UTF-8 file, never a truncated preview.
type FileDocument struct {
	Content  string `json:"content"`
	Revision string `json:"revision"`
	Writable bool   `json:"writable"`
}

func (d FileDocument) Validate() error {
	return FileRevision("revision", d.Revision)
}
