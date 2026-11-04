//go:build integration

package update

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"tmuxde/internal/update/ready"
)

// The copied Go test executable acts as a native application. Appended markers
// change its digest and reported version without a compiler or external service.
func TestIntegrationSupervisorChild(t *testing.T) {
	if os.Getenv("TMUXDE_TEST_CHILD") != "1" {
		return
	}
	if !ready.Initialize() {
		os.Exit(90)
	}
	if os.Getenv("AUTH_TOKEN") != "supervisor-test-credential" {
		os.Exit(91)
	}
	if err := os.Unsetenv("AUTH_TOKEN"); err != nil {
		os.Exit(92)
	}
	binary, err := os.Executable()
	if err != nil {
		os.Exit(93)
	}
	file, err := os.Open(binary)
	if err != nil {
		os.Exit(94)
	}
	if _, err := file.Seek(-64, io.SeekEnd); err != nil {
		os.Exit(95)
	}
	marker, err := io.ReadAll(file)
	file.Close()
	if err != nil {
		os.Exit(96)
	}
	if strings.Contains(string(marker), "TMUXDE-BROKEN") {
		os.Exit(42)
	}
	currentVersion := "1.0.0"
	if strings.Contains(string(marker), "TMUXDE-NEW") {
		currentVersion = "1.2.0"
	}
	ctx, stop := ready.Context(context.Background())
	defer stop()
	if err := ready.Mark(currentVersion); err != nil {
		os.Exit(97)
	}
	markerPath := filepath.Join(filepath.Dir(binary), fmt.Sprintf("child-ready-%d", os.Getpid()))
	if err := os.WriteFile(markerPath, nil, 0600); err != nil {
		os.Exit(98)
	}
	<-ctx.Done()
	os.Exit(ready.ExitCode(0))
}

func fixtureSupervisor(t *testing.T) (*supervisor, context.CancelFunc, <-chan int) {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "application")
	testBinary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if err := copyFile(testBinary, binary, 0755); err != nil {
		t.Fatal(err)
	}
	fixture := &supervisor{
		binary:   binary,
		args:     []string{"-test.run=^TestIntegrationSupervisorChild$"},
		env:      []string{"TMUXDE_TEST_CHILD=1", "AUTH_TOKEN=supervisor-test-credential"},
		stdout:   io.Discard,
		stderr:   io.Discard,
		dir:      filepath.Join(filepath.Dir(binary), ".application-update"),
		requests: make(chan string, 1),
	}
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan int, 1)
	go func() {
		done <- fixture.run(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(15 * time.Second):
			t.Error("supervisor did not stop")
		}
	})
	waitSupervisor(t, func() bool {
		child := fixture.current()
		if child == nil {
			return false
		}
		select {
		case <-child.done:
			t.Fatalf("fixture exited during startup: %d", child.code)
		default:
		}
		markerPath := filepath.Join(filepath.Dir(binary), fmt.Sprintf("child-ready-%d", child.command.Process.Pid))
		_, err := os.Stat(markerPath)
		return err == nil
	})
	// Child must register its graceful update signal before Apply can run.
	waitSupervisor(t, func() bool {
		var info controlInfo
		return controlRequest(t.Context(), fixture.socket, "/info", "", &info) == nil && info.PID > 0
	})
	return fixture, cancel, done
}

func waitSupervisor(t *testing.T, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatal("supervisor operation timed out")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func stageFixture(t *testing.T, s *supervisor, marker string) *transaction {
	t.Helper()
	id := "fixture"
	candidate := filepath.Join(s.dir, id+".candidate")
	if err := copyFile(s.binary, candidate, 0700); err != nil {
		t.Fatal(err)
	}
	file, err := os.OpenFile(candidate, os.O_APPEND|os.O_WRONLY, 0700)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("\n" + marker + "\n"); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	oldHash, err := fileDigest(s.binary)
	if err != nil {
		t.Fatal(err)
	}
	newHash, err := fileDigest(candidate)
	if err != nil {
		t.Fatal(err)
	}
	tx := &transaction{
		ID:              id,
		Binary:          s.binary,
		Version:         "1.2.0",
		PreviousVersion: "1.0.0",
		PreviousDigest:  oldHash,
		CandidateDigest: newHash,
		Mode:            0755,
		Result:          Result{Phase: "staged"},
	}
	if err := save(filepath.Join(s.dir, id+".json"), tx); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(s.dir, "reservation"), []byte(id), 0600); err != nil {
		t.Fatal(err)
	}
	return tx
}

func TestIntegrationSupervisorUpdate(t *testing.T) {
	for _, test := range []struct {
		name   string
		marker string
		phase  string
	}{
		{name: "update", marker: "TMUXDE-NEW", phase: "updated"},
		{name: "startup rollback", marker: "TMUXDE-BROKEN", phase: "rolled-back"},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, _, _ := fixtureSupervisor(t)
			tx := stageFixture(t, s, test.marker)
			before := s.current().command.Process.Pid
			if err := controlRequest(t.Context(), s.socket, "/apply", tx.ID, nil); err != nil {
				t.Fatal(err)
			}
			waitSupervisor(t, func() bool {
				var result transaction
				if read(filepath.Join(s.dir, tx.ID+".json"), &result) != nil {
					return false
				}
				if result.Result.Phase == "failed" || result.Result.Phase == "rollback-failed" {
					t.Fatalf("transaction failed: %+v", result.Result)
				}
				return result.Result.Phase == test.phase
			})
			if after := s.current().command.Process.Pid; after == before {
				t.Fatal("application PID did not change")
			}
			expected := tx.CandidateDigest
			if test.phase == "rolled-back" {
				expected = tx.PreviousDigest
			}
			actual, err := fileDigest(s.binary)
			if err != nil || actual != expected {
				t.Fatalf("installed digest = %s, %v", actual, err)
			}
		})
	}
}

func TestIntegrationSupervisorNormalFailure(t *testing.T) {
	s, _, _ := fixtureSupervisor(t)
	tx := stageFixture(t, s, "TMUXDE-NEW")
	if err := s.current().command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	waitSupervisor(t, func() bool {
		select {
		case <-s.current().done:
			return true
		default:
			return false
		}
	})
	actual, err := fileDigest(s.binary)
	if err != nil || actual != tx.PreviousDigest {
		t.Fatal("ordinary process failure installed staged executable")
	}
}

func TestIntegrationSupervisorRefusesSharedBinary(t *testing.T) {
	s, _, _ := fixtureSupervisor(t)
	other := &supervisor{dir: s.dir}
	if err := other.reserve(); err != nil {
		t.Fatal(err)
	}
	defer other.lock.Close()
	var info controlInfo
	if err := controlRequest(t.Context(), s.socket, "/info", "", &info); err != nil {
		t.Fatal(err)
	}
	if info.Reason == "" {
		t.Fatal("shared binary remained eligible")
	}
	if _, err := os.Stat(filepath.Join(s.dir, "reservation")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("inventory created update reservation: %v", err)
	}
}

func TestIntegrationSupervisorLiveness(t *testing.T) {
	s, _, _ := fixtureSupervisor(t)
	child := s.current()
	if err := child.liveness.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case <-child.done:
		if child.code != 0 {
			t.Fatalf("parent loss exit code = %d", child.code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("child outlived supervisor liveness pipe")
	}
}

func TestIntegrationSupervisorRejectedCandidateKeepsServing(t *testing.T) {
	s, _, _ := fixtureSupervisor(t)
	tx := stageFixture(t, s, "TMUXDE-NEW")
	if err := os.WriteFile(filepath.Join(s.dir, tx.ID+".candidate"), []byte("changed"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := controlRequest(t.Context(), s.socket, "/apply", tx.ID, nil); err != nil {
		t.Fatal(err)
	}
	waitSupervisor(t, func() bool {
		var state transaction
		return read(filepath.Join(s.dir, tx.ID+".json"), &state) == nil && state.Result.Phase == "failed"
	})
	select {
	case <-s.current().done:
		t.Fatal("rejected update left application stopped")
	default:
	}
	digest, err := fileDigest(s.binary)
	if err != nil || digest != tx.PreviousDigest {
		t.Fatalf("previous executable changed: %s, %v", digest, err)
	}
}
