package update

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"
)

func stagedTransaction(t *testing.T) (string, *transaction) {
	t.Helper()
	dir := t.TempDir()
	binary := filepath.Join(dir, "tmuxde")
	candidate := filepath.Join(dir, "test.candidate")
	if err := os.WriteFile(binary, []byte("old executable"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(candidate, []byte("new executable"), 0700); err != nil {
		t.Fatal(err)
	}
	previousHash, err := fileDigest(binary)
	if err != nil {
		t.Fatal(err)
	}
	nextHash, err := fileDigest(candidate)
	if err != nil {
		t.Fatal(err)
	}
	return dir, &transaction{
		ID:              "test",
		Binary:          binary,
		Version:         "1.1.0",
		PreviousVersion: "1.0.0",
		PreviousDigest:  previousHash,
		CandidateDigest: nextHash,
		Mode:            0755,
		Result:          Result{Phase: "starting"},
	}
}

func TestInstallAndRollback(t *testing.T) {
	for _, test := range []struct {
		name         string
		failRestart  bool
		failHealth   bool
		failRollback bool
		phase        string
	}{
		{name: "healthy restart", phase: "updated"},
		{name: "restart fails", failRestart: true, phase: "rolled-back"},
		{name: "health fails", failHealth: true, phase: "rolled-back"},
		{name: "rollback health fails", failHealth: true, failRollback: true, phase: "rollback-failed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			dir, tx := stagedTransaction(t)
			restarts := 0
			phases := []string{}
			engine := installer{
				restart: func(context.Context, string) error {
					restarts++
					if restarts == 1 && test.failRestart {
						return errors.New("restart failed")
					}
					return nil
				},
				wait: func(_ context.Context, _ string, current *transaction, _ time.Duration) error {
					if current.Version == "1.1.0" && test.failHealth {
						return errors.New("startup failed")
					}
					if current.Version == "1.0.0" && test.failRollback {
						return errors.New("rollback startup failed")
					}
					got, err := fileDigest(tx.Binary)
					if err != nil || got != current.CandidateDigest {
						t.Fatalf("running digest = %q, %v", got, err)
					}
					return nil
				},
			}
			report := func(phase, message string) error {
				tx.Result = Result{Phase: phase, Message: message}
				phases = append(phases, phase)
				return nil
			}
			err := engine.install(t.Context(), dir, tx, report)
			if tx.Result.Phase != test.phase || (err == nil) != (test.phase == "updated") {
				t.Fatalf("phase = %s, error = %v", tx.Result.Phase, err)
			}
			if test.phase != "updated" && (!slices.Contains(phases, "rolling-back") || restarts != 2) {
				t.Fatalf("rollback phases = %v, restarts = %d", phases, restarts)
			}
			backup, err := fileDigest(filepath.Join(dir, "test.previous"))
			if err != nil || backup != tx.PreviousDigest {
				t.Fatalf("backup not preserved: %q, %v", backup, err)
			}
		})
	}
}

func TestInstallRecoversAfterRename(t *testing.T) {
	dir, tx := stagedTransaction(t)
	if err := copyFile(tx.Binary, filepath.Join(dir, "test.previous"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(dir, "test.candidate"), tx.Binary); err != nil {
		t.Fatal(err)
	}
	tx.Result.Phase = "installing"
	restarts := 0
	engine := installer{
		restart: func(context.Context, string) error {
			restarts++
			return nil
		},
		wait: func(context.Context, string, *transaction, time.Duration) error {
			return nil
		},
	}
	err := engine.install(t.Context(), dir, tx, func(phase, message string) error {
		tx.Result = Result{Phase: phase, Message: message}
		return nil
	})
	if err != nil || tx.Result.Phase != "updated" || restarts != 1 {
		t.Fatalf("recovery = %+v, restarts = %d, error = %v", tx.Result, restarts, err)
	}
}

func TestInstallRejectsChangedExecutable(t *testing.T) {
	for _, name := range []string{"tmuxde", "test.candidate"} {
		t.Run(name, func(t *testing.T) {
			dir, tx := stagedTransaction(t)
			if err := os.WriteFile(filepath.Join(dir, name), []byte("changed"), 0755); err != nil {
				t.Fatal(err)
			}
			engine := installer{}
			if err := engine.install(t.Context(), dir, tx, nil); err == nil {
				t.Fatal("accepted changed executable")
			}
		})
	}
}
