package update

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"golang.org/x/mod/semver"

	"tmuxde/internal/buildinfo"
	"tmuxde/internal/update/ready"
)

// InstallMode is set to docker for shipped container images.
var InstallMode = "native"

type Host struct {
	Component Component
	Binary    string
	Control   string
	PID       int
	// Busy checks the speech socket before staging or restarting speech.
	Busy func(context.Context) error
}

type transaction struct {
	ID              string    `json:"id"`
	Binary          string    `json:"binary"`
	Version         string    `json:"version"`
	PreviousVersion string    `json:"previousVersion"`
	PID             int       `json:"pid"`
	PreviousDigest  string    `json:"previousDigest"`
	CandidateDigest string    `json:"candidateDigest"`
	Mode            uint32    `json:"mode"`
	Result          Result    `json:"result"`
	Updated         time.Time `json:"updated"`
}

// NewHost identifies this application child and its native supervisor.
func NewHost(id, name, kind, current string) *Host {
	binary, _ := os.Executable()
	host := &Host{
		Component: Component{
			ID:      id,
			Name:    name,
			Kind:    kind,
			Version: current,
			OS:      runtime.GOOS,
			Arch:    runtime.GOARCH,
			Online:  true,
		},
		Binary:  binary,
		Control: ready.Control(),
		PID:     os.Getpid(),
	}
	return host
}

func inContainer() bool {
	if InstallMode == "docker" {
		return true
	}
	for _, marker := range []string{"/.dockerenv", "/run/.containerenv"} {
		if _, err := os.Stat(marker); err == nil {
			return true
		}
	}
	return false
}

func (h *Host) Info(ctx context.Context) Component {
	info := h.Component
	info.Eligible = false
	switch {
	case inContainer():
		info.Reason = "Managed by Docker"
	case h.Control == "":
		info.Reason = "Restart with an updater-capable binary to enable updates"
	default:
		if err := h.preflight(ctx); err != nil {
			info.Reason = err.Error()
		}
	}
	return info
}

func checkCandidate(ctx context.Context, binary, tag string) error {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "version", "--json")
	cmd.WaitDelay = time.Second
	// Version probes must never inherit browser or agent credentials.
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if key == "AUTH_TOKEN" || strings.HasPrefix(key, "TMUXDE_") {
			continue
		}
		cmd.Env = append(cmd.Env, entry)
	}
	output := &commandOutput{}
	cmd.Stdout = output
	if err := cmd.Run(); err != nil {
		return errors.New("candidate compatibility check failed; manual upgrade required")
	}
	return checkCompatibility(output.Bytes(), tag)
}

// Called only after authenticating archive and extracting its executable.
func checkCompatibility(data []byte, tag string) error {
	var info buildinfo.Info
	if err := json.Unmarshal(data, &info); err != nil {
		return errors.New("candidate compatibility information missing; manual upgrade required")
	}
	if version(tag) == "" || version(info.Version) != version(tag) {
		return errors.New("candidate executable version check failed")
	}
	if info.Protocol != buildinfo.ProtocolVersion {
		return errors.New("release changes communication protocol; coordinated manual upgrade required")
	}
	if info.Updater != buildinfo.UpdateProtocol {
		return errors.New("release changes update protocol; manual upgrade and full process restart required")
	}
	return nil
}

type commandOutput struct {
	bytes.Buffer
}

func (b *commandOutput) Write(p []byte) (int, error) {
	if b.Len()+len(p) > 64<<10 {
		return 0, errors.New("command response too large")
	}
	return b.Buffer.Write(p)
}

func (h *Host) preflight(ctx context.Context) error {
	if !filepath.IsAbs(h.Binary) || h.Control == "" {
		return errors.New("native supervisor is unavailable")
	}
	info, err := os.Lstat(h.Binary)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&(os.ModeSetuid|os.ModeSetgid) != 0 {
		return errors.New("binary installation is not replaceable")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Getuid() {
		return errors.New("binary belongs to another user")
	}
	if err := syscall.Access(filepath.Dir(h.Binary), 2); err != nil {
		return errors.New("binary directory is not writable")
	}
	var supervisor controlInfo
	if err := controlRequest(ctx, h.Control, "/info", "", &supervisor); err != nil {
		return err
	}
	if supervisor.Binary != h.Binary || supervisor.PID != h.PID {
		return errors.New("supervisor does not own this application process")
	}
	if supervisor.Reason != "" {
		return errors.New(supervisor.Reason)
	}
	if h.Busy != nil {
		return h.Busy(ctx)
	}
	return nil
}

func (h *Host) directory() string {
	return filepath.Join(filepath.Dir(h.Binary), "."+filepath.Base(h.Binary)+"-update")
}

func (h *Host) Stage(ctx context.Context, id string, p Package) error {
	if !identifier.MatchString(id) {
		return errors.New("invalid update transaction")
	}
	info := h.Info(ctx)
	if info.Reason != "" {
		return errors.New(info.Reason)
	}
	if version(info.Version) == "" || version(p.Tag) == "" {
		return errors.New("custom build requires manual update")
	}
	if semver.Compare(version(p.Tag), version(info.Version)) <= 0 {
		return errors.New("release must be newer than installed version")
	}
	if p.Asset.Name != assetName(info, p.Tag) {
		return errors.New("release does not match this component")
	}
	if err := Verify(p); err != nil {
		return err
	}
	if err := verifyArchive(p); err != nil {
		return err
	}
	dir := h.directory()
	if err := os.Mkdir(dir, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	if err := validateDirectory(dir); err != nil {
		return err
	}
	guard, err := transactionLock(dir)
	if err != nil {
		return err
	}
	defer guard.Close()
	lock, err := os.OpenFile(filepath.Join(dir, "reservation"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return errors.New("another update needs completion or recovery")
	}
	_, err = lock.WriteString(id)
	if err == nil {
		err = lock.Sync()
	}
	if closeErr := lock.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(filepath.Join(dir, "reservation"))
		return err
	}
	ok := false
	defer func() {
		if !ok {
			os.Remove(filepath.Join(dir, id+".candidate"))
			os.Remove(filepath.Join(dir, "reservation"))
		}
	}()
	executable := "tmuxde"
	if info.Kind == "speech" {
		executable = "tmuxde-stt"
	}
	candidate := filepath.Join(dir, id+".candidate")
	if err := extract(p.Archive, executable, candidate); err != nil {
		return err
	}
	if err := checkCandidate(ctx, candidate, p.Tag); err != nil {
		return err
	}
	oldHash, err := fileDigest(h.Binary)
	if err != nil {
		return err
	}
	newHash, err := fileDigest(candidate)
	if err != nil {
		return err
	}
	file, err := os.Stat(h.Binary)
	if err != nil {
		return err
	}
	tx := transaction{
		ID:              id,
		Binary:          h.Binary,
		Version:         strings.TrimPrefix(p.Tag, "v"),
		PreviousVersion: info.Version,
		PID:             h.PID,
		PreviousDigest:  oldHash,
		CandidateDigest: newHash,
		Mode:            uint32(file.Mode().Perm()),
		Result:          Result{Phase: "staged"},
		Updated:         time.Now().UTC(),
	}
	if err := save(filepath.Join(dir, id+".json"), tx); err != nil {
		return err
	}
	ok = true
	return nil
}

func (h *Host) Apply(ctx context.Context, id string) error {
	if !identifier.MatchString(id) {
		return errors.New("invalid update transaction")
	}
	if err := h.preflight(ctx); err != nil {
		return err
	}
	return controlRequest(ctx, h.Control, "/apply", id, nil)
}

func (h *Host) Status(_ context.Context, id string) (Result, error) {
	if !identifier.MatchString(id) {
		return Result{}, errors.New("invalid update transaction")
	}
	var tx transaction
	if err := read(filepath.Join(h.directory(), id+".json"), &tx); err != nil {
		return Result{}, err
	}
	return tx.Result, nil
}

func (h *Host) Cancel(ctx context.Context, id string) error {
	if !identifier.MatchString(id) {
		return errors.New("invalid update transaction")
	}
	lock, err := transactionLock(h.directory())
	if err != nil {
		return err
	}
	defer lock.Close()
	result, err := h.Status(ctx, id)
	if errors.Is(err, os.ErrNotExist) {
		reservation, readErr := readReservation(h.directory())
		if readErr != nil || reservation != id {
			return os.ErrNotExist
		}
		os.Remove(filepath.Join(h.directory(), id+".candidate"))
		return os.Remove(filepath.Join(h.directory(), "reservation"))
	}
	if err != nil {
		return err
	}
	if result.Phase != "staged" {
		return errors.New("installation has already started")
	}
	dir := h.directory()
	if err := os.Remove(filepath.Join(dir, id+".candidate")); err != nil {
		return err
	}
	var tx transaction
	if err := read(filepath.Join(dir, id+".json"), &tx); err != nil {
		return err
	}
	tx.Result = Result{Phase: "cancelled"}
	tx.Updated = time.Now().UTC()
	if err := save(filepath.Join(dir, id+".json"), tx); err != nil {
		return err
	}
	return os.Remove(filepath.Join(dir, "reservation"))
}

func copyFile(source, destination string, mode os.FileMode) error {
	in, err := os.Open(source)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(destination, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
	if err != nil {
		return err
	}
	_, err = io.Copy(out, in)
	if err == nil {
		err = out.Sync()
	}
	if closeErr := out.Close(); err == nil {
		err = closeErr
	}
	return err
}
