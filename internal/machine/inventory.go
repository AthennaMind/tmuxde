package machine

import (
	"encoding/json"
	"io"
)

func writeInventory(w io.Writer, infos []Info) error { return json.NewEncoder(w).Encode(infos) }
