package protocol_test

import (
	"encoding/json"
	"errors"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"

	"tmuxde/internal/protocol"
	"tmuxde/internal/protocol/client"
	"tmuxde/internal/protocol/server"
)

// side is one direction of the protocol as the contract tests see it.
type side struct {
	name   string
	types  func() []string
	new    func(string) (protocol.Message, bool)
	decode func([]byte) (protocol.Message, error)
	source string // TypeScript file with the union for this side
}

var sides = []side{
	{
		name:   protocol.ClientSide,
		types:  client.Types,
		new:    func(t string) (protocol.Message, bool) { return client.New(t) },
		decode: func(b []byte) (protocol.Message, error) { return client.Decode(b) },
		source: "client-messages.ts",
	},
	{
		name:   protocol.ServerSide,
		types:  server.Types,
		new:    func(t string) (protocol.Message, bool) { return server.New(t) },
		decode: func(b []byte) (protocol.Message, error) { return server.Decode(b) },
		source: "server-messages.ts",
	},
}

func sourceDir(t *testing.T) string {
	t.Helper()
	dir, err := protocol.SourceDir()
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestRegistryKeysMatchWireTypes(t *testing.T) {
	for _, s := range sides {
		for _, wireType := range s.types() {
			msg, ok := s.new(wireType)
			if !ok {
				t.Errorf("%s: New(%q) failed", s.name, wireType)
				continue
			}
			if got := msg.WireType(); got != wireType {
				t.Errorf("%s: registry key %q builds %T with WireType %q", s.name, wireType, msg, got)
			}
			if rv := reflect.ValueOf(msg); rv.Kind() != reflect.Pointer || rv.Elem().Kind() != reflect.Struct {
				t.Errorf("%s: %q must build a pointer to a struct, got %T", s.name, wireType, msg)
				continue
			}
			typ := reflect.TypeOf(msg).Elem()
			if typ.NumField() == 0 {
				t.Errorf("%s: %T has no fields", s.name, msg)
				continue
			}
			if first := typ.Field(0); first.Name != "Type" || first.Tag.Get("json") != "type" || first.Type.Kind() != reflect.String {
				t.Errorf("%s: %T must start with Type string `json:\"type\"`", s.name, msg)
			}
		}
	}
}

// TestFixtures checks src/ui/src/protocol/fixtures against the registries.
// Every fixture file names a registered type, every registered type has a
// fixture, and every sample decodes, validates and re-encodes to equal JSON.
func TestFixtures(t *testing.T) {
	root := filepath.Join(sourceDir(t), "fixtures")
	for _, s := range sides {
		t.Run(s.name, func(t *testing.T) {
			entries, err := os.ReadDir(filepath.Join(root, s.name))
			if err != nil {
				t.Fatal(err)
			}
			found := map[string]bool{}
			for _, entry := range entries {
				name := entry.Name()
				wireType := protocol.FixtureType(name)
				if entry.IsDir() || filepath.Ext(name) != ".json" || protocol.FixtureName(wireType) != name {
					t.Errorf("unexpected entry %s/%s", s.name, name)
					continue
				}
				if _, ok := s.new(wireType); !ok {
					t.Errorf("fixture %s/%s has no registered Go type %q", s.name, name, wireType)
					continue
				}
				found[wireType] = true
			}
			for _, wireType := range s.types() {
				if !found[wireType] {
					t.Errorf("type %q has no fixture %s/%s", wireType, s.name, protocol.FixtureName(wireType))
				}
			}
			for _, wireType := range slices.Sorted(maps.Keys(found)) {
				t.Run(wireType, func(t *testing.T) { checkFixture(t, s, wireType) })
			}
		})
	}
}

func checkFixture(t *testing.T, s side, wireType string) {
	samples, err := protocol.LoadFixture(s.name, wireType)
	if err != nil {
		t.Fatal(err)
	}
	var optional []string
	for i, sample := range samples {
		msg, err := s.decode(sample)
		if err != nil {
			t.Errorf("sample %d: %v", i, err)
			continue
		}
		if msg.WireType() != wireType {
			t.Errorf("sample %d: decoded as %q, fixture is %q", i, msg.WireType(), wireType)
		}
		encoded, err := json.Marshal(msg)
		if err != nil {
			t.Errorf("sample %d: encode: %v", i, err)
			continue
		}
		var want, got any
		if err := json.Unmarshal(sample, &want); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(encoded, &got); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(want, got) {
			t.Errorf("sample %d does not round trip\nfixture: %s\nencoded: %s", i, compact(sample), encoded)
		}
		keys := want.(map[string]any)
		if i == 0 {
			optional = optionalFields(msg)
			for _, field := range jsonFields(msg) {
				if _, ok := keys[field]; !ok {
					t.Errorf("sample 0 must set every field, %q is missing", field)
				}
			}
		}
	}
	if len(optional) == 0 {
		return
	}
	for _, sample := range samples[1:] {
		var keys map[string]any
		if json.Unmarshal(sample, &keys) != nil {
			continue
		}
		if !slices.ContainsFunc(optional, func(f string) bool { _, ok := keys[f]; return ok }) {
			return
		}
	}
	t.Errorf("needs a later sample without the optional fields %v", optional)
}

// TestInvalidFixtures checks src/ui/src/protocol/fixtures/invalid. Each file
// holds entries { field, message } for one wire type. Zod rejects every
// message, so Decode must reject it too, and for the named field. This
// catches a Validate that is looser than its Zod schema.
func TestInvalidFixtures(t *testing.T) {
	root := filepath.Join(sourceDir(t), "fixtures", "invalid")
	for _, s := range sides {
		t.Run(s.name, func(t *testing.T) {
			entries, err := os.ReadDir(filepath.Join(root, s.name))
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) == 0 {
				t.Fatal("no invalid fixtures")
			}
			for _, entry := range entries {
				name := entry.Name()
				wireType := protocol.FixtureType(name)
				if entry.IsDir() || filepath.Ext(name) != ".json" || protocol.FixtureName(wireType) != name {
					t.Errorf("unexpected entry invalid/%s/%s", s.name, name)
					continue
				}
				if _, ok := s.new(wireType); !ok {
					t.Errorf("invalid/%s/%s has no registered Go type %q", s.name, name, wireType)
					continue
				}
				t.Run(wireType, func(t *testing.T) {
					checkInvalidFixture(t, s, filepath.Join(root, s.name, name), wireType)
				})
			}
		})
	}
}

type invalidSample struct {
	Field   string          `json:"field"`
	Message json.RawMessage `json:"message"`
}

func checkInvalidFixture(t *testing.T, s side, path, wireType string) {
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var samples []invalidSample
	if err := json.Unmarshal(data, &samples); err != nil {
		t.Fatal(err)
	}
	if len(samples) == 0 {
		t.Fatal("no samples")
	}
	for i, sample := range samples {
		if sample.Field == "" || len(sample.Message) == 0 {
			t.Errorf("sample %d must be { field, message }", i)
			continue
		}
		msg, err := s.decode(sample.Message)
		if err == nil {
			t.Errorf("sample %d (%s): accepted as %T, Zod rejects it", i, sample.Field, msg)
			continue
		}
		if !errors.Is(err, protocol.ErrInvalid) {
			t.Errorf("sample %d (%s): %v is not ErrInvalid", i, sample.Field, err)
			continue
		}
		if !strings.Contains(err.Error(), "invalid message "+wireType+":") {
			t.Errorf("sample %d (%s): %v is not about %s", i, sample.Field, err, wireType)
		}
		fields := errorFields(err)
		if !slices.Contains(fields, sample.Field) {
			t.Errorf("sample %d: refused for %v, want %s: %v", i, fields, sample.Field, err)
		}
	}
}

// errorFields collects the field paths named in err, in the FieldError
// format such as panes[0].index.
func errorFields(err error) []string {
	var out []string
	var walk func(error)
	walk = func(err error) {
		switch e := err.(type) {
		case *protocol.FieldError:
			out = append(out, e.Field)
			return
		case *json.UnmarshalTypeError:
			out = append(out, bracketIndices(e.Field))
			return
		case interface{ Unwrap() []error }:
			for _, inner := range e.Unwrap() {
				walk(inner)
			}
		case interface{ Unwrap() error }:
			if inner := e.Unwrap(); inner != nil {
				walk(inner)
			}
		}
	}
	walk(err)
	return out
}

// bracketIndices turns an encoding/json path such as panes.0.index into
// panes[0].index.
func bracketIndices(path string) string {
	var b strings.Builder
	for i, part := range strings.Split(path, ".") {
		switch {
		case i > 0 && part != "" && strings.Trim(part, "0123456789") == "":
			b.WriteString("[" + part + "]")
		case i > 0:
			b.WriteString("." + part)
		default:
			b.WriteString(part)
		}
	}
	return b.String()
}

func jsonFields(msg protocol.Message) []string {
	var out []string
	typ := reflect.TypeOf(msg).Elem()
	for i := range typ.NumField() {
		name, _, _ := strings.Cut(typ.Field(i).Tag.Get("json"), ",")
		if name != "" && name != "-" {
			out = append(out, name)
		}
	}
	return out
}

func optionalFields(msg protocol.Message) []string {
	var out []string
	typ := reflect.TypeOf(msg).Elem()
	for i := range typ.NumField() {
		name, opts, _ := strings.Cut(typ.Field(i).Tag.Get("json"), ",")
		if name == "" || name == "-" {
			continue
		}
		for opt := range strings.SplitSeq(opts, ",") {
			if opt == "omitempty" || opt == "omitzero" {
				out = append(out, name)
				break
			}
		}
	}
	return out
}

func compact(data []byte) string {
	var v any
	_ = json.Unmarshal(data, &v)
	out, _ := json.Marshal(v)
	return string(out)
}

var (
	typeLiteral = regexp.MustCompile(`\btype:\s*z\.literal\(\s*"([^"]+)"\s*\)`)
	exportConst = regexp.MustCompile(`export const (\w+)\s*=`)
	repoImport  = regexp.MustCompile(`import\s*\{([^}]*)\}\s*from\s*"\./repository"`)
)

// liveTypes reads the wire types per side from the TypeScript sources.
// repository.ts types go to the side whose union file imports their schema.
func liveTypes(t *testing.T) map[string][]string {
	t.Helper()
	src := sourceDir(t)
	read := func(name string) string {
		data, err := os.ReadFile(filepath.Join(src, name))
		if err != nil {
			t.Fatal(err)
		}
		return string(data)
	}
	out := map[string][]string{}
	imports := map[string]string{}
	for _, s := range sides {
		text := read(s.source)
		for _, m := range typeLiteral.FindAllStringSubmatch(text, -1) {
			out[s.name] = append(out[s.name], m[1])
		}
		for _, m := range repoImport.FindAllStringSubmatch(text, -1) {
			for name := range strings.SplitSeq(m[1], ",") {
				name = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(name), "type "))
				if name != "" {
					imports[name] = s.name
				}
			}
		}
	}
	repo := read("repository.ts")
	exports := exportConst.FindAllStringSubmatchIndex(repo, -1)
	for _, m := range typeLiteral.FindAllStringSubmatchIndex(repo, -1) {
		wireType := repo[m[2]:m[3]]
		owner := ""
		for _, e := range exports {
			if e[0] < m[0] {
				owner = repo[e[2]:e[3]]
			}
		}
		sideName, ok := imports[owner]
		if !ok {
			t.Errorf("repository.ts: %q belongs to %q, which no union file imports", wireType, owner)
			continue
		}
		out[sideName] = append(out[sideName], wireType)
	}
	return out
}

// TestTypeList requires the Go registries to match the live TypeScript
// wire types in both directions.
func TestTypeList(t *testing.T) {
	live := liveTypes(t)
	missingTotal := 0
	for _, s := range sides {
		var want []string
		for _, wireType := range live[s.name] {
			if !slices.Contains(want, wireType) {
				want = append(want, wireType)
			}
		}
		slices.Sort(want)
		have := s.types()
		var missing, extra []string
		for _, wireType := range want {
			if !slices.Contains(have, wireType) {
				missing = append(missing, wireType)
			}
		}
		for _, wireType := range have {
			if !slices.Contains(want, wireType) {
				extra = append(extra, wireType)
			}
		}
		missingTotal += len(missing)
		if len(missing) > 0 {
			t.Errorf("%s: %d of %d TypeScript types have no Go type:\n  %s",
				s.name, len(missing), len(want), strings.Join(missing, "\n  "))
		}
		if len(extra) > 0 {
			t.Errorf("%s: %d Go types are not live in TypeScript:\n  %s",
				s.name, len(extra), strings.Join(extra, "\n  "))
		}
	}
	if missingTotal > 0 {
		t.Logf("%d types missing in total", missingTotal)
	}
}
