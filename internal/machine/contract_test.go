package machine

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"tmuxde/internal/protocol"
)

func TestInventoryContract(t *testing.T) {
	dir, err := protocol.SourceDir()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "fixtures", "http", "machines.json"))
	if err != nil {
		t.Fatal(err)
	}
	var infos []Info
	if err := json.Unmarshal(data, &infos); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(infos)
	if err != nil {
		t.Fatal(err)
	}
	var before, after any
	if err := json.Unmarshal(data, &before); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, &after); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, after) {
		t.Fatal("machine inventory fixture lost fields on Go round trip")
	}
}
