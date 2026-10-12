package protocol

import (
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf16"
)

// Validation helpers. Each returns nil or a *FieldError. Combine them with
// errors.Join, which drops the nils.

// Literal checks a z.literal field, usually type.
func Literal(field, got, want string) error {
	if got != want {
		return &FieldError{field, fmt.Sprintf("must be %q", want)}
	}
	return nil
}

// Length is the string length as JavaScript counts it, in UTF-16 code
// units. Zod .min and .max on strings use this count.
func Length(s string) int {
	n := 0
	for _, r := range s {
		if l := utf16.RuneLen(r); l > 0 {
			n += l
		} else {
			n++
		}
	}
	return n
}

// MinLength mirrors z.string().min(n).
func MinLength(field, s string, n int) error {
	if Length(s) < n {
		return &FieldError{field, fmt.Sprintf("must be at least %d characters", n)}
	}
	return nil
}

// MaxLength mirrors z.string().max(n).
func MaxLength(field, s string, n int) error {
	if Length(s) > n {
		return &FieldError{field, fmt.Sprintf("must be at most %d characters", n)}
	}
	return nil
}

// LengthBetween mirrors z.string().min(lo).max(hi).
func LengthBetween(field, s string, lo, hi int) error {
	if n := Length(s); n < lo || n > hi {
		return &FieldError{field, fmt.Sprintf("must be %d to %d characters", lo, hi)}
	}
	return nil
}

// Pattern mirrors z.string().regex(re). Go and JavaScript agree on ^ and $
// without the m flag: both match only at the ends of the input.
func Pattern(field, s string, re *regexp.Regexp) error {
	if !re.MatchString(s) {
		return &FieldError{field, "has an invalid format"}
	}
	return nil
}

// Number is the set of Go types used for z.number().
type Number interface {
	~int | ~int64 | ~float64
}

// Min mirrors z.number().min(lo). Use Min(field, v, 1) for .positive() on
// integers.
func Min[T Number](field string, v, lo T) error {
	if v < lo {
		return &FieldError{field, fmt.Sprintf("must be at least %v", lo)}
	}
	return nil
}

// Max mirrors z.number().max(hi).
func Max[T Number](field string, v, hi T) error {
	if v > hi {
		return &FieldError{field, fmt.Sprintf("must be at most %v", hi)}
	}
	return nil
}

// Between mirrors z.number().min(lo).max(hi).
func Between[T Number](field string, v, lo, hi T) error {
	if v < lo || v > hi {
		return &FieldError{field, fmt.Sprintf("must be %v to %v", lo, hi)}
	}
	return nil
}

// Positive mirrors z.number().positive() on floats.
func Positive(field string, v float64) error {
	if v <= 0 {
		return &FieldError{field, "must be positive"}
	}
	return nil
}

// OneOf mirrors z.enum.
func OneOf(field, v string, allowed ...string) error {
	if !slices.Contains(allowed, v) {
		return &FieldError{field, "must be one of " + strings.Join(allowed, ", ")}
	}
	return nil
}

// RequiredSlice mirrors a required z.array. Go encodes a nil slice as
// null and Zod refuses null for an array, so a nil slice fails here and
// Encode never sends it. An empty slice passes. Pair it with Each when the
// items have their own Validate.
func RequiredSlice[T any](field string, items []T) error {
	if items == nil {
		return &FieldError{field, "must not be null"}
	}
	return nil
}

// Validator is a nested value with its own Validate.
type Validator interface {
	Validate() error
}

// Nested validates a nested value and prefixes its field paths with field.
func Nested(field string, v Validator) error {
	return Within(field, v.Validate())
}

// Each validates every item and prefixes paths with field[i].
func Each[T Validator](field string, items []T) error {
	var errs []error
	for i, item := range items {
		errs = append(errs, Within(fmt.Sprintf("%s[%d]", field, i), item.Validate()))
	}
	return errors.Join(errs...)
}

// Within prefixes the field path of every FieldError in err.
func Within(prefix string, err error) error {
	if err == nil {
		return nil
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		var errs []error
		for _, inner := range joined.Unwrap() {
			errs = append(errs, Within(prefix, inner))
		}
		return errors.Join(errs...)
	}
	if fe, ok := err.(*FieldError); ok {
		return &FieldError{join(prefix, fe.Field), fe.Reason}
	}
	return fmt.Errorf("%s: %w", prefix, err)
}
