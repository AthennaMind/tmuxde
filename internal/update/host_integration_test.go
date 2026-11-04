//go:build integration

package update

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"tmuxde/internal/buildinfo"
)

func TestIntegrationCandidateProbe(t *testing.T) {
	t.Setenv("AUTH_TOKEN", "must-not-reach-candidate")
	t.Setenv("TMUXDE_UPDATE_CONTROL", "must-not-reach-candidate")
	info := buildinfo.Info{Version: "1.2.3", Protocol: buildinfo.ProtocolVersion, Updater: buildinfo.UpdateProtocol}
	data, err := json.Marshal(info)
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name   string
		script string
		valid  bool
	}{
		{name: "compatible", script: "cat <<'INFO'\n" + string(data) + "\nINFO\n", valid: true},
		{name: "old binary", script: "echo 1.2.3\n"},
		{name: "unsupported flag", script: "exit 2\n"},
		{name: "excess output", script: "head -c 65537 /dev/zero\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			binary := filepath.Join(t.TempDir(), "candidate")
			script := "#!/bin/sh\nset -eu\n" +
				"[ \"$#\" = 2 ] && [ \"$1\" = version ] && [ \"$2\" = --json ] || exit 10\n" +
				"[ -z \"${AUTH_TOKEN+x}\" ] && [ -z \"${TMUXDE_UPDATE_CONTROL+x}\" ] || exit 11\n" + test.script
			if err := os.WriteFile(binary, []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			if err := checkCandidate(t.Context(), binary, "v1.2.3"); (err == nil) != test.valid {
				t.Fatalf("candidate check = %v, want valid %v", err, test.valid)
			}
		})
	}
}
