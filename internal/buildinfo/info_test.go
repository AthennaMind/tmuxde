package buildinfo

import (
	"bytes"
	"encoding/json"
	"testing"
)

func TestVersionCommand(t *testing.T) {
	for _, name := range []string{"tmuxde", "tmuxde-stt"} {
		for _, test := range []struct {
			name string
			args []string
			code int
		}{
			{name: "plain"},
			{name: "json", args: []string{"--json"}},
			{name: "help", args: []string{"--help"}},
			{name: "unknown flag", args: []string{"--unknown"}, code: 2},
			{name: "extra argument", args: []string{"--json", "extra"}, code: 2},
		} {
			t.Run(name+"/"+test.name, func(t *testing.T) {
				var stdout, stderr bytes.Buffer
				code := Command(name, "1.2.3", test.args, &stdout, &stderr)
				if code != test.code {
					t.Fatalf("exit code = %d: %s", code, &stderr)
				}
				switch test.name {
				case "plain":
					if stdout.String() != "1.2.3\n" {
						t.Fatalf("version = %q", &stdout)
					}
				case "json":
					var info Info
					if err := json.Unmarshal(stdout.Bytes(), &info); err != nil {
						t.Fatal(err)
					}
					if info.Version != "1.2.3" || info.Protocol != ProtocolVersion || info.Updater != UpdateProtocol {
						t.Fatalf("compatibility = %+v", info)
					}
				default:
					if stdout.Len() != 0 || stderr.Len() == 0 {
						t.Fatalf("stdout = %q, stderr = %q", &stdout, &stderr)
					}
				}
			})
		}
	}
}

func TestVersionCommandWriteError(t *testing.T) {
	for _, args := range [][]string{nil, {"--json"}} {
		var stderr bytes.Buffer
		if code := Command("tmuxde", "dev", args, failingWriter{}, &stderr); code != 1 {
			t.Fatalf("exit code = %d", code)
		}
		if stderr.Len() == 0 {
			t.Fatalf("stderr = %q", &stderr)
		}
	}
}

type failingWriter struct{}

func (failingWriter) Write([]byte) (int, error) {
	return 0, bytes.ErrTooLarge
}
