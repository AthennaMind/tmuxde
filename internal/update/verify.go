package update

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	_ "embed"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path"
	"strings"

	"github.com/sigstore/sigstore-go/pkg/bundle"
	"github.com/sigstore/sigstore-go/pkg/root"
	"github.com/sigstore/sigstore-go/pkg/verify"
)

// Trusted material is refreshed by maintainers through verified Sigstore TUF.
// Runtime verification is offline and never accepts roots supplied by a release.
//
//go:embed trusted-root.json
var trustedRoot []byte

// Verify authenticates release metadata before any executable is accepted.
func Verify(p Package) error {
	if version(p.Tag) == "" || len(p.Checksums) > maxMetadata || len(p.Bundle) > maxMetadata {
		return errors.New("invalid update metadata")
	}
	if err := verifySignature(p.Tag, p.Checksums, p.Bundle); err != nil {
		return err
	}
	_, err := checksum(p.Checksums, p.Asset.Name)
	return err
}

func verifySignature(tag string, checksums, signatureData []byte) error {
	trusted, err := root.NewTrustedRootFromJSON(trustedRoot)
	if err != nil {
		return err
	}
	verifier, err := verify.NewVerifier(trusted,
		verify.WithSignedCertificateTimestamps(1),
		verify.WithTransparencyLog(1),
		verify.WithObserverTimestamps(1),
	)
	if err != nil {
		return err
	}
	identity, err := verify.NewShortCertificateIdentity(
		"https://token.actions.githubusercontent.com", "",
		"https://github.com/"+Repository+"/.github/workflows/release.yml@refs/tags/"+tag, "",
	)
	if err != nil {
		return err
	}
	var signature bundle.Bundle
	if err := signature.UnmarshalJSON(signatureData); err != nil {
		return errors.New("invalid release signature bundle")
	}
	digest := sha256.Sum256(checksums)
	_, err = verifier.Verify(&signature, verify.NewPolicy(
		verify.WithArtifactDigest("sha256", digest[:]),
		verify.WithCertificateIdentity(identity),
	))
	if err != nil {
		return errors.New("release signature verification failed")
	}
	return nil
}

func checksum(data []byte, name string) (string, error) {
	var found string
	for line := range strings.SplitSeq(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) != 2 || strings.TrimPrefix(fields[1], "*") != name {
			continue
		}
		decoded, err := hex.DecodeString(fields[0])
		if found != "" || err != nil || len(decoded) != sha256.Size {
			return "", errors.New("invalid release checksum")
		}
		found = strings.ToLower(fields[0])
	}
	if found == "" {
		return "", errors.New("release checksum missing")
	}
	return found, nil
}

func fileDigest(name string) (string, error) {
	f, err := os.Open(name)
	if err != nil {
		return "", err
	}
	defer f.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, io.LimitReader(f, maxPayload+1))
	if err != nil {
		return "", err
	}
	if size > maxPayload {
		return "", errors.New("update file too large")
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func verifyArchive(p Package) error {
	info, err := os.Stat(p.Archive)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() != p.Asset.Size || info.Size() > maxArchive {
		return errors.New("invalid archive size")
	}
	expected, err := checksum(p.Checksums, p.Asset.Name)
	if err != nil {
		return err
	}
	actual, err := fileDigest(p.Archive)
	if err != nil {
		return err
	}
	if actual != expected || (p.Asset.Digest != "" && p.Asset.Digest != "sha256:"+actual) {
		return errors.New("archive checksum mismatch")
	}
	return nil
}

// extract writes only the expected regular executable. Other archive entries
// are inspected and bounded, but never created on the host filesystem.
func extract(archive, executable, destination string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gzipReader, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	defer gzipReader.Close()
	reader := tar.NewReader(io.LimitReader(gzipReader, maxPayload+(16<<20)))
	found := false
	var total int64
	for count := 0; ; count++ {
		header, err := reader.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return err
		}
		name := strings.TrimPrefix(header.Name, "./")
		if header.Typeflag == tar.TypeDir {
			name = strings.TrimSuffix(name, "/")
		}
		if count > 32 || path.IsAbs(name) || path.Clean(name) != name || name == ".." || strings.HasPrefix(name, "../") || strings.Contains(name, "\\") {
			return errors.New("unsafe release archive entry")
		}
		if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeDir {
			return errors.New("release archive contains links or special files")
		}
		total += header.Size
		if header.Size < 0 || total > maxPayload {
			return errors.New("release payload too large")
		}
		if name != executable {
			continue
		}
		if found || header.Typeflag != tar.TypeReg || header.Size == 0 {
			return errors.New("invalid executable in release")
		}
		found = true
		out, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0700)
		if err != nil {
			return err
		}
		_, err = io.Copy(out, reader)
		if err == nil {
			err = out.Sync()
		}
		if closeErr := out.Close(); err == nil {
			err = closeErr
		}
		if err != nil {
			return err
		}
	}
	if !found {
		return errors.New("release executable missing")
	}
	return nil
}
