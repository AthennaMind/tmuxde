package protocol

import (
	"errors"
	"strings"
	"testing"
)

type testInner struct {
	N int     `json:"n"`
	S *string `json:"s,omitempty"`
}

func (i testInner) Validate() error { return Between("n", i.N, 0, 9) }

type testMessage struct {
	Type     string      `json:"type"`
	Name     string      `json:"name"`
	Opt      *bool       `json:"opt,omitempty"`
	Nullable *string     `json:"nullable"`
	Inner    testInner   `json:"inner"`
	InnerOpt *testInner  `json:"innerOpt,omitempty"`
	List     []testInner `json:"list"`
	Tags     []string    `json:"tags,omitzero"`
}

func (*testMessage) WireType() string { return "test:message" }

func (m *testMessage) Validate() error {
	return errors.Join(
		Literal("type", m.Type, "test:message"),
		MaxLength("name", m.Name, 5),
		Nested("inner", m.Inner),
		Each("list", m.List),
	)
}

var testRegistry = Merge(map[string]func() Message{
	"test:message": func() Message { return &testMessage{} },
})

func TestDecode(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		wantErr error
		wantMsg string
	}{
		{
			name:  "full",
			input: `{"type":"test:message","name":"abc","opt":false,"nullable":"x","inner":{"n":1,"s":""},"innerOpt":{"n":2},"list":[{"n":3}],"tags":[]}`,
		},
		{
			name:  "minimal with null nullable",
			input: `{"type":"test:message","name":"","nullable":null,"inner":{"n":0},"list":[]}`,
		},
		{
			name:  "unknown keys ignored",
			input: `{"type":"test:message","name":"a","nullable":null,"inner":{"n":0,"extra":1},"list":[],"extra":true}`,
		},
		{name: "array", input: `[]`, wantErr: ErrNotObject},
		{name: "null", input: `null`, wantErr: ErrNotObject},
		{name: "string", input: `"auth"`, wantErr: ErrNotObject},
		{name: "broken", input: `{"type":`, wantErr: ErrNotObject},
		{name: "no type", input: `{}`, wantErr: ErrNoType},
		{name: "type not string", input: `{"type":1}`, wantErr: ErrNoType},
		{name: "type null", input: `{"type":null}`, wantErr: ErrNoType},
		{name: "unknown type", input: `{"type":"nope"}`, wantErr: ErrUnknownType},
		{
			name:    "missing required",
			input:   `{"type":"test:message","nullable":null,"inner":{"n":0},"list":[]}`,
			wantErr: ErrInvalid, wantMsg: "name: required",
		},
		{
			name:    "required is null",
			input:   `{"type":"test:message","name":null,"nullable":null,"inner":{"n":0},"list":[]}`,
			wantErr: ErrInvalid, wantMsg: "name: must not be null",
		},
		{
			name:    "nullable still required",
			input:   `{"type":"test:message","name":"a","inner":{"n":0},"list":[]}`,
			wantErr: ErrInvalid, wantMsg: "nullable: required",
		},
		{
			name:    "optional is null",
			input:   `{"type":"test:message","name":"a","opt":null,"nullable":null,"inner":{"n":0},"list":[]}`,
			wantErr: ErrInvalid, wantMsg: "opt: must not be null",
		},
		{
			name:    "nested required",
			input:   `{"type":"test:message","name":"a","nullable":null,"inner":{},"list":[]}`,
			wantErr: ErrInvalid, wantMsg: "inner.n: required",
		},
		{
			name:    "nested not object",
			input:   `{"type":"test:message","name":"a","nullable":null,"inner":[],"list":[]}`,
			wantErr: ErrInvalid, wantMsg: "inner: must be an object",
		},
		{
			name:    "optional nested required",
			input:   `{"type":"test:message","name":"a","nullable":null,"inner":{"n":0},"innerOpt":{"s":"x"},"list":[]}`,
			wantErr: ErrInvalid, wantMsg: "innerOpt.n: required",
		},
		{
			name:    "null list item",
			input:   `{"type":"test:message","name":"a","nullable":null,"inner":{"n":0},"list":[{"n":1},null]}`,
			wantErr: ErrInvalid, wantMsg: "list[1]: must not be null",
		},
		{
			name:    "list item missing field",
			input:   `{"type":"test:message","name":"a","nullable":null,"inner":{"n":0},"list":[{}]}`,
			wantErr: ErrInvalid, wantMsg: "list[0].n: required",
		},
		{
			name:    "null string item",
			input:   `{"type":"test:message","name":"a","nullable":null,"inner":{"n":0},"list":[],"tags":[null]}`,
			wantErr: ErrInvalid, wantMsg: "tags[0]: must not be null",
		},
		{
			name:    "wrong case key",
			input:   `{"type":"test:message","name":"a","Name":"evil","nullable":null,"inner":{"n":0},"list":[]}`,
			wantErr: ErrInvalid, wantMsg: `Name: unknown key, did you mean "name"`,
		},
		{
			name:    "wrong case nested key",
			input:   `{"type":"test:message","name":"a","nullable":null,"inner":{"n":0,"N":5},"list":[]}`,
			wantErr: ErrInvalid, wantMsg: `inner.N: unknown key`,
		},
		{
			name:    "wrong json type",
			input:   `{"type":"test:message","name":1,"nullable":null,"inner":{"n":0},"list":[]}`,
			wantErr: ErrInvalid, wantMsg: "cannot unmarshal number",
		},
		{
			name:    "float for int",
			input:   `{"type":"test:message","name":"a","nullable":null,"inner":{"n":1.5},"list":[]}`,
			wantErr: ErrInvalid, wantMsg: "cannot unmarshal number 1.5",
		},
		{
			name:    "too long",
			input:   `{"type":"test:message","name":"abcdef","nullable":null,"inner":{"n":0},"list":[]}`,
			wantErr: ErrInvalid, wantMsg: "name: must be at most 5 characters",
		},
		{
			name:    "nested range",
			input:   `{"type":"test:message","name":"a","nullable":null,"inner":{"n":0},"list":[{"n":4},{"n":10}]}`,
			wantErr: ErrInvalid, wantMsg: "list[1].n: must be 0 to 9",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			msg, err := Decode([]byte(tt.input), testRegistry)
			if tt.wantErr == nil {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if msg.WireType() != "test:message" {
					t.Fatalf("decoded %T", msg)
				}
				return
			}
			if !errors.Is(err, tt.wantErr) {
				t.Fatalf("error %v, want %v", err, tt.wantErr)
			}
			if !strings.Contains(err.Error(), tt.wantMsg) {
				t.Fatalf("error %q does not contain %q", err, tt.wantMsg)
			}
		})
	}
}

func TestEncodeValidates(t *testing.T) {
	_, err := Encode(&testMessage{Name: "a"})
	if !errors.Is(err, ErrInvalid) || !strings.Contains(err.Error(), `type: must be "test:message"`) {
		t.Fatalf("missing type not refused: %v", err)
	}
	data, err := Encode(&testMessage{Type: "test:message", Name: "a"})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"type":"test:message","name":"a","nullable":null,"inner":{"n":0},"list":null}`
	if string(data) != want {
		t.Fatalf("got %s\nwant %s", data, want)
	}
}

func TestEncodeKeepsHTMLCharacters(t *testing.T) {
	data, err := Encode(&testMessage{Type: "test:message", Name: "<&>"})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"type":"test:message","name":"<&>","nullable":null,"inner":{"n":0},"list":null}`
	if string(data) != want {
		t.Fatalf("got %s\nwant %s", data, want)
	}
}

func TestMergePanicsOnDuplicate(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("no panic")
		}
	}()
	build := func() Message { return &testMessage{} }
	Merge(map[string]func() Message{"a": build}, map[string]func() Message{"a": build})
}

func TestRegistry(t *testing.T) {
	if got := testRegistry.Types(); len(got) != 1 || got[0] != "test:message" {
		t.Fatalf("Types() = %v", got)
	}
	if _, ok := testRegistry.New("missing"); ok {
		t.Fatal("New on unknown type succeeded")
	}
}

func TestLength(t *testing.T) {
	tests := []struct {
		in   string
		want int
	}{
		{"", 0},
		{"abc", 3},
		{"é", 1},
		{"日本", 2},
		{"\U0001F600", 2},
		{"a\U0001F600b", 4},
	}
	for _, tt := range tests {
		if got := Length(tt.in); got != tt.want {
			t.Errorf("Length(%q) = %d, want %d", tt.in, got, tt.want)
		}
	}
}

func TestHelpers(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want string
	}{
		{"literal ok", Literal("type", "a", "a"), ""},
		{"literal", Literal("type", "b", "a"), `type: must be "a"`},
		{"min length ok", MinLength("id", "a", 1), ""},
		{"min length", MinLength("id", "", 1), "id: must be at least 1 characters"},
		{"max length counts utf16", MaxLength("id", "\U0001F600\U0001F600", 3), "id: must be at most 3 characters"},
		{"length between", LengthBetween("id", "", 1, 64), "id: must be 1 to 64 characters"},
		{"min", Min("skip", -1, 0), "skip: must be at least 0"},
		{"max", Max("lines", 501, 500), "lines: must be at most 500"},
		{"between ok", Between("cols", 1000, 1, 1000), ""},
		{"positive", Positive("at", 0), "at: must be positive"},
		{"one of ok", OneOf("files", "read", "none", "read"), ""},
		{"one of", OneOf("files", "all", "none", "read"), "files: must be one of none, read"},
		{"within", Within("size", Between("cols", 0, 1, 2)), "size.cols: must be 1 to 2"},
		{"within nil", Within("size", nil), ""},
		{"within plain", Within("size", errors.New("boom")), "size: boom"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ""
			if tt.err != nil {
				got = tt.err.Error()
			}
			if got != tt.want {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestSharedTypesValidate(t *testing.T) {
	size := func(c, r int) *TerminalSize { return &TerminalSize{Cols: c, Rows: r} }
	tests := []struct {
		name string
		v    Validator
		want string
	}{
		{"size ok", TerminalSize{Cols: 1000, Rows: 500}, ""},
		{"size cols", TerminalSize{Cols: 0, Rows: 1}, "cols: must be 1 to 1000"},
		{"size rows", TerminalSize{Cols: 1, Rows: 501}, "rows: must be 1 to 500"},
		{"session no size", SessionInfo{}, ""},
		{"session size", SessionInfo{Dimensions: size(1, 0)}, "dimensions.rows: must be 1 to 500"},
		{"pane size", PaneInfo{Dimensions: TerminalSize{}}, "dimensions.cols: must be 1 to 1000"},
		{"window size", WindowInfo{Dimensions: size(1001, 1)}, "dimensions.cols: must be 1 to 1000"},
		{"entry type", FileEntry{Type: "fifo"}, "type: must be one of file, directory, symlink, other"},
		{"stat type", FileStat{Type: "symlink"}, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ""
			if err := tt.v.Validate(); err != nil {
				got = err.Error()
			}
			if !strings.Contains(got, tt.want) || (tt.want == "" && got != "") {
				t.Fatalf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestFixtureNames(t *testing.T) {
	if got := FixtureName("file:write:result"); got != "file.write.result.json" {
		t.Fatalf("FixtureName = %q", got)
	}
	if got := FixtureType("file.write.result.json"); got != "file:write:result" {
		t.Fatalf("FixtureType = %q", got)
	}
}
