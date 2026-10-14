package tmux

import (
	"bytes"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"tmuxde/internal/protocol"
)

func ptr[T any](v T) *T { return &v }

func TestParseSessions(t *testing.T) {
	// Captured from tmux 3.3a with sessionFormat. The second session has
	// no window size yet, which tmux prints as two empty fields.
	out := "work\t$0\t3\t1\t1791811386\t1791811400\t200\t50\n" +
		" spaced \t$1\t1\t0\t1791811387\t1791811387\t\t\n"
	got := parseSessions(out)
	want := []protocol.SessionInfo{
		{
			Name: "work", ID: "$0", Windows: 3, Attached: true,
			Created:    "2026-10-12T13:23:06.000Z",
			Activity:   "2026-10-12T13:23:20.000Z",
			Dimensions: &protocol.TerminalSize{Cols: 200, Rows: 50},
		},
		{
			Name: " spaced ", ID: "$1", Windows: 1, Attached: false,
			Created:  "2026-10-12T13:23:07.000Z",
			Activity: "2026-10-12T13:23:07.000Z",
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseSessions =\n%+v\nwant\n%+v", got, want)
	}
}

func TestParseEmptyListsAreNotNil(t *testing.T) {
	// A nil slice encodes as null, which the browser refuses.
	for name, isNil := range map[string]bool{
		"sessions": parseSessions("") == nil,
		"windows":  parseWindows("\n") == nil,
		"panes":    parsePanes("") == nil,
		"names":    parseNames("") == nil,
	} {
		if isNil {
			t.Errorf("%s: empty output parsed to nil", name)
		}
	}
}

func TestParseDimensionsNeedBothValues(t *testing.T) {
	tests := []struct {
		w, h string
		want *protocol.TerminalSize
	}{
		{"80", "24", &protocol.TerminalSize{Cols: 80, Rows: 24}},
		{"", "24", nil},
		{"80", "", nil},
		{"", "", nil},
	}
	for _, tt := range tests {
		if got := dimensions(tt.w, tt.h); !reflect.DeepEqual(got, tt.want) {
			t.Errorf("dimensions(%q, %q) = %v, want %v", tt.w, tt.h, got, tt.want)
		}
	}
}

func TestParseWindows(t *testing.T) {
	out := "@0\t0\tsh\t0\t1\tb25d,200x49,0,0,0\t200\t49\t1\t0\n" +
		"@2\t1\teditor\t1\t3\t5a1e,200x49,0,0{100x49,0,0,1,99x49,101,0,2}\t200\t49\t0\t1\n"
	got := parseWindows(out)
	want := []protocol.WindowInfo{
		{
			ID: "@0", Index: 0, Name: "sh", Active: false, PaneCount: 1,
			Layout: "b25d,200x49,0,0,0", Activity: ptr(true), Zoomed: ptr(false),
			Dimensions: &protocol.TerminalSize{Cols: 200, Rows: 49},
		},
		{
			ID: "@2", Index: 1, Name: "editor", Active: true, PaneCount: 3,
			Layout:   "5a1e,200x49,0,0{100x49,0,0,1,99x49,101,0,2}",
			Activity: ptr(false), Zoomed: ptr(true),
			Dimensions: &protocol.TerminalSize{Cols: 200, Rows: 49},
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parseWindows =\n%+v\nwant\n%+v", got, want)
	}
}

func TestParsePanes(t *testing.T) {
	out := strings.Join([]string{
		// Active pane of a zoomed window: zoomed.
		"%1\t0\t@2\t1\t1\t200\t49\t0\t0\tvim\t/home/u/src",
		// Inactive pane of the same zoomed window: not zoomed.
		"%2\t1\t@2\t0\t1\t99\t49\t101\t0\tbash\t/home/u",
		// Active pane of a window that is not zoomed. Command and path
		// are empty and must be omitted.
		"%3\t0\t@3\t1\t0\t80\t24\t0\t0\t\t",
		// A tab inside the path stays in the path.
		"%4\t1\t@3\t0\t0\t80\t24\t0\t12\tsh\t/tmp/a\tb",
		// The tail of a path that held a newline is not a pane.
		"rest of a path",
	}, "\n") + "\n"
	got := parsePanes(out)
	want := []protocol.PaneInfo{
		{
			ID: "%1", Index: 0, WindowID: "@2", Active: true, Zoomed: true,
			Dimensions: protocol.TerminalSize{Cols: 200, Rows: 49},
			Position:   protocol.Position{X: 0, Y: 0},
			Command:    ptr("vim"), Path: ptr("/home/u/src"),
		},
		{
			ID: "%2", Index: 1, WindowID: "@2", Active: false, Zoomed: false,
			Dimensions: protocol.TerminalSize{Cols: 99, Rows: 49},
			Position:   protocol.Position{X: 101, Y: 0},
			Command:    ptr("bash"), Path: ptr("/home/u"),
		},
		{
			ID: "%3", Index: 0, WindowID: "@3", Active: true, Zoomed: false,
			Dimensions: protocol.TerminalSize{Cols: 80, Rows: 24},
		},
		{
			ID: "%4", Index: 1, WindowID: "@3", Active: false, Zoomed: false,
			Dimensions: protocol.TerminalSize{Cols: 80, Rows: 24},
			Position:   protocol.Position{X: 0, Y: 12},
			Command:    ptr("sh"), Path: ptr("/tmp/a\tb"),
		},
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("parsePanes =\n%+v\nwant\n%+v", got, want)
	}
}

func TestParseCreated(t *testing.T) {
	name, id := parseCreated("work\t$4\n")
	if name != "work" || id != "$4" {
		t.Fatalf("parseCreated = %q, %q", name, id)
	}
}

func TestParseZoom(t *testing.T) {
	tests := []struct {
		out              string
		window, thisPane bool
	}{
		{"1\t1\n", true, true},
		{"1\t0\n", true, false},
		{"0\t1\n", false, false},
		// display-message prints empty fields for a target that is gone.
		{"\t\n", false, false},
	}
	for _, tt := range tests {
		w, p := parseZoom(tt.out)
		if w != tt.window || p != tt.thisPane {
			t.Errorf("parseZoom(%q) = %v, %v, want %v, %v", tt.out, w, p, tt.window, tt.thisPane)
		}
	}
}

func TestParseScrollState(t *testing.T) {
	tests := []struct {
		name string
		out  string
		want ScrollState
	}{
		{
			name: "shell at the bottom",
			out:  "%0\t0\t\t12049\t49\t200\t0\t0\t0\t0\n",
			want: ScrollState{Pane: "%0", HistorySize: 12049, PaneHeight: 49, Width: 200},
		},
		{
			name: "copy mode",
			out:  "%0\t1\t9\t12049\t49\t200\t0\t0\t0\t0\n",
			want: ScrollState{Pane: "%0", InMode: true, Position: 9, HistorySize: 12049, PaneHeight: 49, Width: 200},
		},
		{
			name: "alternate screen app hides the history",
			out:  "%5\t0\t0\t100\t49\t200\t1\t0\t0\t0\n",
			want: ScrollState{Pane: "%5", PaneHeight: 49, Width: 200, Application: true},
		},
		{
			name: "inline mouse app",
			out:  "%6\t0\t0\t100\t49\t200\t0\t1\t1\t0\n",
			want: ScrollState{Pane: "%6", PaneHeight: 49, Width: 200, Application: true, Mouse: true, SGR: true},
		},
		{
			name: "copy mode over an app is not the app",
			out:  "%7\t1\t3\t0\t49\t200\t1\t1\t0\t1\n",
			want: ScrollState{Pane: "%7", InMode: true, Position: 3, PaneHeight: 49, Width: 200, Mouse: true, UTF8: true},
		},
		{
			name: "negative and garbage read as 0",
			out:  "%8\t0\t-4\tx\t-1\t\t0\t0\t0\t0\n",
			want: ScrollState{Pane: "%8"},
		},
		{
			name: "target gone falls back to the target",
			out:  "\t\t\t\t\t\t\t\t\t\n",
			want: ScrollState{Pane: "=work:"},
		},
		{
			name: "short output",
			out:  "",
			want: ScrollState{Pane: "=work:"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseScrollState(tt.out, "=work:"); got != tt.want {
				t.Fatalf("parseScrollState =\n%+v\nwant\n%+v", got, tt.want)
			}
		})
	}
}

func TestAtoiLikeParseInt(t *testing.T) {
	tests := []struct {
		in   string
		want int
	}{
		{"42", 42}, {" 7", 7}, {"-3", -3}, {"+5", 5}, {"12abc", 12},
		{"", 0}, {"abc", 0}, {"-", 0}, {"1e3", 1},
	}
	for _, tt := range tests {
		if got := atoi(tt.in); got != tt.want {
			t.Errorf("atoi(%q) = %d, want %d", tt.in, got, tt.want)
		}
	}
}

func TestISOTime(t *testing.T) {
	ts := time.Date(2026, 10, 12, 9, 3, 4, 120_000_000, time.FixedZone("CEST", 2*3600))
	if got, want := isoTime(ts), "2026-10-12T07:03:04.120Z"; got != want {
		t.Fatalf("isoTime = %q, want %q", got, want)
	}
	if got, want := epochISO("0"), "1970-01-01T00:00:00.000Z"; got != want {
		t.Fatalf("epochISO(0) = %q, want %q", got, want)
	}
}

func TestHasZFlag(t *testing.T) {
	tests := []struct {
		usage string
		want  bool
	}{
		// tmux 3.3a.
		{"select-pane (selectp) [-DdeLlMmRUZ] [-T title] [-t target-pane]\n", true},
		// tmux 3.0a, before -Z.
		{"select-pane (selectp) [-DdegLlMmRU] [-P style] [-T title] [-t target-pane]\n", false},
		{"select-pane [-Z]", true},
		{"select-pane [-T title] Z", false},
		{"", false},
	}
	for _, tt := range tests {
		if got := hasZFlag(tt.usage); got != tt.want {
			t.Errorf("hasZFlag(%q) = %v, want %v", tt.usage, got, tt.want)
		}
	}
}

func TestWheelEvent(t *testing.T) {
	tests := []struct {
		name         string
		button, x, y int
		sgr, utf8    bool
		want         []byte
	}{
		{"sgr up", wheelUp, 100, 25, true, false, []byte("\x1b[<64;100;25M")},
		{"sgr down", wheelDown, 1, 1, true, false, []byte("\x1b[<65;1;1M")},
		{"legacy bytes", wheelUp, 100, 25, false, false, []byte{27, 91, 77, 96, 132, 57}},
		{"legacy caps at 223", wheelDown, 500, 300, false, false, []byte{27, 91, 77, 97, 255, 255}},
		// 132 is two bytes in UTF-8: 0xc2 0x84.
		{"utf8 encodes each value", wheelUp, 100, 25, false, true, []byte{27, 91, 77, 96, 0xc2, 0x84, 57}},
		// 2015 + 32 = 2047, the largest two byte character: 0xdf 0xbf.
		{"utf8 caps at 2015", wheelUp, 5000, 1, false, true, []byte{27, 91, 77, 96, 0xdf, 0xbf, 33}},
		// SGR has no cap.
		{"sgr ignores the cap", wheelUp, 5000, 300, true, true, []byte("\x1b[<64;5000;300M")},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := wheelEvent(tt.button, tt.x, tt.y, tt.sgr, tt.utf8); !bytes.Equal(got, tt.want) {
				t.Fatalf("wheelEvent = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestHexArgs(t *testing.T) {
	got := hexArgs([]byte{0x1b, 0x5b, 0x4d, 0x60, 0x0a, 0x00, 0xff})
	want := []string{"1b", "5b", "4d", "60", "a", "0", "ff"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("hexArgs = %q, want %q", got, want)
	}
}

func TestTargets(t *testing.T) {
	if got, err := sessionTarget("work"); err != nil || got != "=work" {
		t.Errorf("sessionTarget = %q, %v", got, err)
	}
	if got, err := currentTarget(" spaced "); err != nil || got != "= spaced :" {
		t.Errorf("currentTarget = %q, %v", got, err)
	}
	if got, err := sessionTarget("work$0"); err != nil || got != "=work$0" {
		t.Errorf("sessionTarget(work$0) = %q, %v", got, err)
	}
	for _, ok := range []string{"%0", "%12"} {
		if err := checkPaneID(ok); err != nil {
			t.Errorf("checkPaneID(%q) = %v", ok, err)
		}
	}
	for _, bad := range []string{"", "%", "@1", "%1a", "=work:", "%-1", "1"} {
		if err := checkPaneID(bad); err == nil {
			t.Errorf("checkPaneID(%q) accepted", bad)
		}
	}
	if err := checkWindowID("@3"); err != nil {
		t.Errorf("checkWindowID(@3) = %v", err)
	}
	if err := checkWindowID("%3"); err == nil {
		t.Error("checkWindowID(%3) accepted")
	}
}

// sessionNameCases are names and why checkSession refuses them. An empty
// why means the name is accepted.
var sessionNameCases = []struct {
	name, why string
}{
	{"work", ""},
	{" spaced ", ""},
	{"work$0", ""},
	{"-life", ""},
	{"=work", ""},
	{"__tmuxde", ""},
	{"\u00e9t\u00e9", ""},
	{"", "is empty"},
	{"a:b", `contains ":" or "."`},
	{"a.b", `contains ":" or "."`},
	{"work:", `contains ":" or "."`},
	{":", `contains ":" or "."`},
	// tmux reads a leading "$" as a session id, "=" or not.
	{"$0", `starts with "$"`},
	{"$", `starts with "$"`},
	{"$work", `starts with "$"`},
	// tmux tries a client name when no session matches exactly.
	{"a/b", `contains "/"`},
	{"pts/3", `contains "/"`},
	{"/dev/pts/3", `contains "/"`},
	{"/", `contains "/"`},
}

func TestCheckSession(t *testing.T) {
	for _, tt := range sessionNameCases {
		err := checkSession(tt.name)
		_, errT := sessionTarget(tt.name)
		_, errC := currentTarget(tt.name)
		if tt.why == "" {
			if err != nil || errT != nil || errC != nil {
				t.Errorf("%q refused: %v, %v, %v", tt.name, err, errT, errC)
			}
			continue
		}
		if !errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), tt.why) {
			t.Errorf("checkSession(%q) = %v, want ErrInvalidArgument that %s", tt.name, err, tt.why)
		}
		if !errors.Is(errT, ErrInvalidArgument) || !errors.Is(errC, ErrInvalidArgument) {
			t.Errorf("targets for %q = %v, %v, want ErrInvalidArgument", tt.name, errT, errC)
		}
	}
}

func TestCheckNewSession(t *testing.T) {
	tests := []struct {
		name, why string
	}{
		// tmux turns ":" and "." into "_" in a new name, so they pass.
		{"edit-main.go", ""},
		{"a:b", ""},
		{".", ""},
		{"work", ""},
		{"-life", ""},
		{"work$0", ""},
		{"", "is empty"},
		{"$0", `starts with "$"`},
		{"$a.b", `starts with "$"`},
		{"a/b", `contains "/"`},
		{"pts/3", `contains "/"`},
		{"x.y/z", `contains "/"`},
	}
	for _, tt := range tests {
		err := checkNewSession(tt.name)
		if tt.why == "" {
			if err != nil {
				t.Errorf("checkNewSession(%q) = %v", tt.name, err)
			}
			continue
		}
		if !errors.Is(err, ErrInvalidArgument) || !strings.Contains(err.Error(), tt.why) {
			t.Errorf("checkNewSession(%q) = %v, want ErrInvalidArgument that %s", tt.name, err, tt.why)
		}
	}
	// What checkSession refuses after the tmux rewrite is refused here too.
	for _, tt := range sessionNameCases {
		if strings.ContainsAny(tt.name, ":.") {
			continue
		}
		if err := checkNewSession(tt.name); (err == nil) != (tt.why == "") {
			t.Errorf("checkNewSession(%q) = %v, checkSession says %q", tt.name, err, tt.why)
		}
	}
}

func TestCommandEnv(t *testing.T) {
	got := commandEnv([]string{
		"HOME=/home/u", "TMUX=/tmp/tmux-1000/default,12,0", "TMUX_PANE=%3",
		"AUTH_TOKEN=secret", "TMUX_SOCKET=/s", "LANG=C.UTF-8",
	})
	want := []string{"HOME=/home/u", "LANG=C.UTF-8"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("commandEnv = %q, want %q", got, want)
	}
}

func TestSubcommand(t *testing.T) {
	tests := []struct {
		args []string
		want string
	}{
		{[]string{"-S", "/s", "list-sessions", "-F", "x"}, "list-sessions"},
		{[]string{"kill-session", "-t", "=a"}, "kill-session"},
		{[]string{"-V"}, "-V"},
		{[]string{"-N", "-V"}, "-V"},
		{[]string{"-N", "-S", "/s", "new-session", "-d"}, "new-session"},
		{nil, ""},
	}
	for _, tt := range tests {
		if got := subcommand(tt.args); got != tt.want {
			t.Errorf("subcommand(%q) = %q, want %q", tt.args, got, tt.want)
		}
	}
}
