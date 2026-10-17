package bundle

import (
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
)

func fixture(data string) fstest.MapFS {
	return fstest.MapFS{
		"model.onnx":    {Data: []byte(data)},
		"manifest.json": {Data: fmt.Appendf(nil, `{"model.onnx":"%x"}`, sha256.Sum256([]byte(data)))},
	}
}

func TestCacheRepairsAndReusesModels(t *testing.T) {
	source := fixture("model")
	cache := t.TempDir()
	dir, err := materialize(source, cache)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "model.onnx")
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := materialize(source, cache); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(path)
	if err != nil || !os.SameFile(before, after) {
		t.Fatalf("valid cache was replaced: %v", err)
	}
	if err := os.WriteFile(path, []byte("damaged"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := materialize(source, cache); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "model" {
		t.Fatalf("cache not repaired: %q, %v", data, err)
	}
}

func TestCorruptBundleNeverPublishesModel(t *testing.T) {
	source := fixture("expected")
	source["model.onnx"].Data = []byte("corrupt")
	cache := t.TempDir()
	if _, err := materialize(source, cache); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("expected checksum error, got %v", err)
	}
	files, err := filepath.Glob(filepath.Join(cache, "*", "*"))
	if err != nil || len(files) != 0 {
		t.Fatalf("partial model left behind: %v, %v", files, err)
	}
}

func TestManifestRefusesTraversal(t *testing.T) {
	source := fixture("model")
	source["manifest.json"].Data = fmt.Appendf(nil, `{"../outside":"%x"}`, sha256.Sum256([]byte("model")))
	if _, err := materialize(source, t.TempDir()); err == nil {
		t.Fatal("accepted traversal")
	}
}

func TestConcurrentExtraction(t *testing.T) {
	cache := t.TempDir()
	var wg sync.WaitGroup
	for range 4 {
		wg.Go(func() {
			if _, err := materialize(fixture("model"), cache); err != nil {
				t.Error(err)
			}
		})
	}
	wg.Wait()
}
