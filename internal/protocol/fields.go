package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"sync"
)

// FieldError names the field that failed and why. Field is a path such as
// "capabilities.files" or "panes[2].dimensions.cols".
type FieldError struct {
	Field  string
	Reason string
}

func (e *FieldError) Error() string {
	return e.Field + ": " + e.Reason
}

// CheckFields checks a JSON object against the json tags of v, a pointer to
// a struct. It is what Zod does before it looks at values:
//
//   - A field without omitempty or omitzero must be present.
//   - Only a pointer field without omitempty may be null.
//   - A key that matches a field name only when case is ignored is refused.
//     encoding/json would fill the field from it, Zod would drop it.
//
// Nested structs, pointers to structs and slices of them are checked the
// same way. A type with its own UnmarshalJSON checks itself and may call
// CheckFields from there.
func CheckFields(data []byte, v any) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		return ErrNotObject
	}
	return checkObject(fields, v)
}

func checkObject(fields map[string]json.RawMessage, v any) error {
	t := reflect.TypeOf(v)
	for t != nil && t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	if t == nil || t.Kind() != reflect.Struct {
		return fmt.Errorf("protocol: CheckFields needs a struct, got %T", v)
	}
	return checkStruct("", fields, t)
}

type fieldInfo struct {
	name     string
	typ      reflect.Type
	optional bool
	nullable bool
}

var fieldCache sync.Map // reflect.Type -> []fieldInfo

func structFields(t reflect.Type) []fieldInfo {
	if cached, ok := fieldCache.Load(t); ok {
		return cached.([]fieldInfo)
	}
	var out []fieldInfo
	for i := range t.NumField() {
		f := t.Field(i)
		tag := f.Tag.Get("json")
		if tag == "-" {
			continue
		}
		name, opts, _ := strings.Cut(tag, ",")
		if f.Anonymous && name == "" && f.Type.Kind() == reflect.Struct {
			out = append(out, structFields(f.Type)...)
			continue
		}
		if !f.IsExported() {
			continue
		}
		if name == "" {
			name = f.Name
		}
		optional := hasOption(opts, "omitempty") || hasOption(opts, "omitzero")
		out = append(out, fieldInfo{
			name:     name,
			typ:      f.Type,
			optional: optional,
			nullable: !optional && f.Type.Kind() == reflect.Pointer,
		})
	}
	fieldCache.Store(t, out)
	return out
}

func hasOption(opts, want string) bool {
	for opt := range strings.SplitSeq(opts, ",") {
		if opt == want {
			return true
		}
	}
	return false
}

var (
	jsonNull        = []byte("null")
	unmarshalerType = reflect.TypeFor[json.Unmarshaler]()
)

func checkStruct(path string, fields map[string]json.RawMessage, t reflect.Type) error {
	infos := structFields(t)
	for key := range fields {
		for _, info := range infos {
			if key != info.name && strings.EqualFold(key, info.name) {
				return &FieldError{join(path, key), fmt.Sprintf("unknown key, did you mean %q", info.name)}
			}
		}
	}
	for _, info := range infos {
		at := join(path, info.name)
		raw, present := fields[info.name]
		if !present {
			if info.optional {
				continue
			}
			return &FieldError{at, "required"}
		}
		if bytes.Equal(bytes.TrimSpace(raw), jsonNull) {
			if info.nullable {
				continue
			}
			return &FieldError{at, "must not be null"}
		}
		if err := checkValue(at, raw, info.typ); err != nil {
			return err
		}
	}
	return nil
}

func checkValue(path string, raw json.RawMessage, t reflect.Type) error {
	if t.Implements(unmarshalerType) || reflect.PointerTo(t).Implements(unmarshalerType) {
		return nil
	}
	switch t.Kind() {
	case reflect.Pointer:
		return checkValue(path, raw, t.Elem())
	case reflect.Struct:
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &fields) != nil || fields == nil {
			return &FieldError{path, "must be an object"}
		}
		return checkStruct(path, fields, t)
	case reflect.Slice:
		if t.Elem().Kind() == reflect.Uint8 {
			// []byte is a base64 string on the wire.
			return nil
		}
		// No Zod array in the protocol allows null items. encoding/json
		// would turn them into zero values.
		var items []json.RawMessage
		if json.Unmarshal(raw, &items) != nil {
			return &FieldError{path, "must be an array"}
		}
		for i, item := range items {
			at := fmt.Sprintf("%s[%d]", path, i)
			if bytes.Equal(bytes.TrimSpace(item), jsonNull) {
				return &FieldError{at, "must not be null"}
			}
			if err := checkValue(at, item, t.Elem()); err != nil {
				return err
			}
		}
	}
	return nil
}

func join(path, name string) string {
	if path == "" {
		return name
	}
	return path + "." + name
}
