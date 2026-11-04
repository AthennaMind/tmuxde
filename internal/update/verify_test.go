package update

import (
	"archive/tar"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReleaseSignature(t *testing.T) {
	checksums, err := os.ReadFile("testdata/v0.0.6-checksums.txt")
	if err != nil {
		t.Fatal(err)
	}
	bundle, err := os.ReadFile("testdata/v0.0.6-checksums.sigstore.json")
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		name      string
		tag       string
		data      []byte
		signature []byte
		valid     bool
	}{
		{name: "published release", tag: "v0.0.6", data: checksums, signature: bundle, valid: true},
		{name: "wrong tag identity", tag: "v0.0.7", data: checksums, signature: bundle},
		{name: "tampered checksums", tag: "v0.0.6", data: append([]byte("x"), checksums...), signature: bundle},
		{name: "missing bundle", tag: "v0.0.6", data: checksums},
		{name: "malformed bundle", tag: "v0.0.6", data: checksums, signature: []byte(`{}`)},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := verifySignature(test.tag, test.data, test.signature)
			if (err == nil) != test.valid {
				t.Fatalf("verification error = %v, want valid %v", err, test.valid)
			}
			pkg := Package{
				Tag:       test.tag,
				Asset:     Asset{Name: "tmuxde_0.0.6_linux_amd64.tar.gz"},
				Checksums: test.data,
				Bundle:    test.signature,
			}
			if err := Verify(pkg); (err == nil) != test.valid {
				t.Fatalf("package verification error = %v, want valid %v", err, test.valid)
			}
			pkg.Asset.Name = "unsigned.tar.gz"
			if err := Verify(pkg); err == nil {
				t.Fatal("accepted archive missing from signed checksums")
			}
		})
	}
}

func TestArchiveSafety(t *testing.T) {
	for _, test := range []struct {
		name    string
		entries []tar.Header
		valid   bool
	}{
		{name: "binary and docs", entries: []tar.Header{{Name: "tmuxde", Typeflag: tar.TypeReg}, {Name: "docs/", Typeflag: tar.TypeDir}, {Name: "docs/install.md", Typeflag: tar.TypeReg}}, valid: true},
		{name: "parent traversal", entries: []tar.Header{{Name: "../tmuxde", Typeflag: tar.TypeReg}}},
		{name: "absolute path", entries: []tar.Header{{Name: "/tmuxde", Typeflag: tar.TypeReg}}},
		{name: "symlink", entries: []tar.Header{{Name: "tmuxde", Typeflag: tar.TypeSymlink, Linkname: "/bin/sh"}}},
		{name: "hardlink", entries: []tar.Header{{Name: "tmuxde", Typeflag: tar.TypeLink, Linkname: "file"}}},
		{name: "duplicate binary", entries: []tar.Header{{Name: "tmuxde", Typeflag: tar.TypeReg}, {Name: "tmuxde", Typeflag: tar.TypeReg}}},
		{name: "missing binary", entries: []tar.Header{{Name: "README.md", Typeflag: tar.TypeReg}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir := t.TempDir()
			archive := filepath.Join(dir, "release.tar.gz")
			file, err := os.Create(archive)
			if err != nil {
				t.Fatal(err)
			}
			compressed := gzip.NewWriter(file)
			writer := tar.NewWriter(compressed)
			for _, entry := range test.entries {
				if entry.Typeflag == tar.TypeReg {
					entry.Size = 7
				}
				if err := writer.WriteHeader(&entry); err != nil {
					t.Fatal(err)
				}
				if entry.Size > 0 {
					if _, err := writer.Write([]byte("payload")); err != nil {
						t.Fatal(err)
					}
				}
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			if err := compressed.Close(); err != nil {
				t.Fatal(err)
			}
			if err := file.Close(); err != nil {
				t.Fatal(err)
			}
			candidate := filepath.Join(dir, "candidate")
			if err := extract(archive, "tmuxde", candidate); (err == nil) != test.valid {
				t.Fatalf("extract error = %v, want valid %v", err, test.valid)
			}
			if test.valid {
				contents, err := os.ReadFile(candidate)
				if err != nil || string(contents) != "payload" {
					t.Fatalf("candidate = %q, %v", contents, err)
				}
			}
		})
	}
}

func TestChecksumRejectsDuplicate(t *testing.T) {
	line := strings.Repeat("a", 64) + "  binary.tar.gz\n"
	if _, err := checksum([]byte(line+line), "binary.tar.gz"); err == nil {
		t.Fatal("accepted duplicate checksum")
	}
}
