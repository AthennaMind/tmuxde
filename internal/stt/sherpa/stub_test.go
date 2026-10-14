//go:build !(sherpa && cgo)

package sherpa

import (
	"errors"
	"strings"
	"testing"
)

func TestStubNamesTheBuildTag(t *testing.T) {
	if _, err := NewRecognizer(RecognizerConfig{}); !errors.Is(err, ErrNotBuilt) {
		t.Fatalf("NewRecognizer error = %v, want ErrNotBuilt", err)
	}
	if _, err := NewVAD(VADConfig{}); !errors.Is(err, ErrNotBuilt) {
		t.Fatalf("NewVAD error = %v, want ErrNotBuilt", err)
	}
	if !strings.Contains(ErrNotBuilt.Error(), "-tags sherpa") {
		t.Fatalf("error %q does not name the build tag", ErrNotBuilt)
	}
	if Built {
		t.Fatal("Built is true in a stub build")
	}
}
