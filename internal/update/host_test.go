package update

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"tmuxde/internal/buildinfo"
)

func TestCancelInterruptedStaging(t *testing.T) {
	host := &Host{Binary: filepath.Join(t.TempDir(), "tmuxde")}
	dir := host.directory()
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "reservation"), []byte("interrupted"), 0600); err != nil {
		t.Fatal(err)
	}
	candidate := filepath.Join(dir, "interrupted.candidate")
	if err := os.WriteFile(candidate, []byte("partial archive"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := host.Cancel(t.Context(), "different"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("cancel unrelated transaction = %v", err)
	}
	if err := host.Cancel(t.Context(), "interrupted"); err != nil {
		t.Fatal(err)
	}
	for _, file := range []string{candidate, filepath.Join(dir, "reservation")} {
		if _, err := os.Stat(file); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("staging file still exists: %s, %v", file, err)
		}
	}
}

func TestCandidateCompatibility(t *testing.T) {
	for _, test := range []struct {
		name   string
		change func(*buildinfo.Info)
		valid  bool
	}{
		{name: "compatible", valid: true},
		{name: "version prefix", change: func(info *buildinfo.Info) { info.Version = "v1.2.3" }, valid: true},
		{name: "wrong version", change: func(info *buildinfo.Info) { info.Version = "1.2.4" }},
		{name: "custom version", change: func(info *buildinfo.Info) { info.Version = "dev" }},
		{name: "new protocol", change: func(info *buildinfo.Info) { info.Protocol++ }},
		{name: "missing protocol", change: func(info *buildinfo.Info) { info.Protocol = 0 }},
		{name: "missing updater", change: func(info *buildinfo.Info) { info.Updater = "" }},
		{name: "new updater", change: func(info *buildinfo.Info) { info.Updater += "-next" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			info := buildinfo.Info{Version: "1.2.3", Protocol: buildinfo.ProtocolVersion, Updater: buildinfo.UpdateProtocol}
			if test.change != nil {
				test.change(&info)
			}
			data, err := json.Marshal(info)
			if err != nil {
				t.Fatal(err)
			}
			if err := checkCompatibility(data, "v1.2.3"); (err == nil) != test.valid {
				t.Fatalf("compatibility error = %v, want valid %v", err, test.valid)
			}
		})
	}
	for _, data := range []string{"1.2.3", "{}", "null", `{"version":"1.2.3"}`, `{} {}`} {
		if err := checkCompatibility([]byte(data), "v1.2.3"); err == nil {
			t.Fatalf("accepted invalid metadata %q", data)
		}
	}
}
