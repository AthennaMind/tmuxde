package tmux

import (
	"strings"
	"testing"
)

func TestNormalizeLayout(t *testing.T) {
	const nested = `{"V":2,"L":{"t":"h","w":81,"h":24,"x":0,"y":0,"c":[{"t":"p","w":40,"h":24,"x":0,"y":0,"l":1,"i":0,"I":"%34"},{"t":"v","w":40,"h":24,"x":41,"y":0,"c":[{"t":"p","w":40,"h":11,"x":41,"y":0,"l":0,"i":1,"I":"%35"},{"t":"p","w":40,"h":12,"x":41,"y":12,"a":true,"i":2,"I":"%36"}]}]}}`
	const body = "81x24,0,0{40x24,0,0,34,40x24,41,0[40x11,41,0,35,40x12,41,12,36]}"
	got := normalizeLayout(nested)
	_, shape, ok := strings.Cut(got, ",")
	if !ok || shape != body {
		t.Fatalf("normalizeLayout = %q, want body %q", got, body)
	}
	// Pane indexes differ from IDs. Visit order and active state are metadata.
	changed := strings.ReplaceAll(nested, `"l":1`, `"l":9`)
	changed = strings.ReplaceAll(changed, `"a":true`, `"a":false`)
	if normalizeLayout(changed) != got {
		t.Fatal("pane metadata changed layout geometry")
	}
	for _, legacy := range []string{"", "b25d,200x49,0,0,0", body} {
		if normalizeLayout(legacy) != legacy {
			t.Fatalf("changed legacy layout %q", legacy)
		}
	}
	for _, invalid := range []string{
		`{`, `{"V":3,"L":{}}`, `{"V":2}`, `{"V":2,"L":null}`,
		strings.Replace(nested, `"t":"h"`, `"t":"unknown"`, 1),
		strings.Replace(nested, `"I":"%34"`, `"I":"bad"`, 1),
		strings.Replace(nested, `"w":81`, `"w":0`, 1),
		strings.Replace(nested, `"x":0`, `"x":-1`, 1),
		strings.Replace(nested, `"l":1`, `"z":0`, 1),
		`{"V":2,"L":{"t":"h","w":80,"h":24,"c":[]}}`,
	} {
		if normalizeLayout(invalid) != "" {
			t.Fatalf("accepted unsupported layout %q", invalid)
		}
	}
	// Exercise the actual window parser used by server and agents.
	windows := parseWindows("@1\t0\twork\t1\t3\t" + nested + "\t81\t24\t0\t0\n")
	if len(windows) != 1 || windows[0].Layout != got {
		t.Fatalf("parseWindows did not normalize layout: %+v", windows)
	}
}

func TestLayoutChecksum(t *testing.T) {
	if got := layoutChecksum("200x49,0,0,0"); got != "ce9d" {
		t.Fatalf("layoutChecksum = %q, want ce9d", got)
	}
}
