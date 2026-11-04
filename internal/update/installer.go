package update

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

func transactionLock(dir string) (*os.File, error) {
	if err := validateDirectory(dir); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(filepath.Join(dir, "lock"), os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("update transaction is busy")
	}
	return f, nil
}

func validateDirectory(dir string) error {
	info, err := os.Lstat(dir)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode().Perm() != 0700 {
		return errors.New("unsafe update directory")
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(stat.Uid) != os.Getuid() {
		return errors.New("update directory has wrong owner")
	}
	return nil
}

type installer struct {
	restart func(context.Context, string) error
	wait    func(context.Context, string, *transaction, time.Duration) error
}

func (i installer) install(ctx context.Context, dir string, tx *transaction, report func(string, string) error) error {
	candidate := filepath.Join(dir, tx.ID+".candidate")
	previous := filepath.Join(dir, tx.ID+".previous")
	if tx.Result.Phase == "rolling-back" {
		return i.rollback(ctx, dir, tx, previous, report, errors.New(tx.Result.Message))
	}
	installedHash, err := fileDigest(tx.Binary)
	if err != nil {
		return err
	}
	if installedHash != tx.PreviousDigest && installedHash != tx.CandidateDigest {
		return errors.New("installed binary changed while update was staged")
	}
	if installedHash == tx.PreviousDigest {
		newHash, err := fileDigest(candidate)
		if err != nil || newHash != tx.CandidateDigest {
			return errors.New("staged binary changed")
		}
		if err := report("installing", ""); err != nil {
			return err
		}
		backupHash, err := fileDigest(previous)
		if errors.Is(err, os.ErrNotExist) {
			err = copyFile(tx.Binary, previous, os.FileMode(tx.Mode))
		} else if err == nil && backupHash != tx.PreviousDigest {
			err = errors.New("previous executable backup changed")
		}
		if err != nil {
			return err
		}
		if err := syncDirectory(dir); err != nil {
			return err
		}
		if err := os.Chmod(candidate, os.FileMode(tx.Mode)); err != nil {
			return err
		}
		if err := os.Rename(candidate, tx.Binary); err != nil {
			return err
		}
		if err := syncDirectory(filepath.Dir(tx.Binary)); err != nil {
			return i.rollback(ctx, dir, tx, previous, report, err)
		}
	}
	if err := report("restarting", ""); err != nil {
		return i.rollback(ctx, dir, tx, previous, report, err)
	}
	if err := i.restart(ctx, tx.Binary); err != nil {
		return i.rollback(ctx, dir, tx, previous, report, err)
	}
	if err := i.wait(ctx, dir, tx, 3*time.Minute); err != nil {
		return i.rollback(ctx, dir, tx, previous, report, err)
	}
	return report("updated", "")
}

func syncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return err
	}
	defer dir.Close()
	return dir.Sync()
}

func (i installer) rollback(ctx context.Context, dir string, tx *transaction, previous string, report func(string, string) error, cause error) error {
	// Restore availability even when shutdown cancelled the install context.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 3*time.Minute+15*time.Second)
	defer cancel()
	if err := report("rolling-back", cause.Error()); err != nil {
		return errors.Join(cause, err)
	}
	digest, err := fileDigest(previous)
	if err != nil || digest != tx.PreviousDigest {
		_ = report("rollback-failed", "Previous executable backup is unavailable or changed")
		return errors.Join(cause, errors.New("backup verification failed"))
	}
	restore := filepath.Join(dir, tx.ID+".restore")
	_ = os.Remove(restore)
	if err := copyFile(previous, restore, os.FileMode(tx.Mode)); err != nil {
		_ = report("rollback-failed", "Could not prepare previous executable")
		return errors.Join(cause, err)
	}
	if err := os.Rename(restore, tx.Binary); err != nil {
		_ = report("rollback-failed", "Could not restore previous executable")
		return errors.Join(cause, err)
	}
	if err := syncDirectory(filepath.Dir(tx.Binary)); err != nil {
		return errors.Join(cause, err)
	}
	if err := i.restart(ctx, tx.Binary); err != nil {
		_ = report("rollback-failed", "Previous executable restored but service restart failed")
		return errors.Join(cause, err)
	}
	restored := *tx
	restored.CandidateDigest = tx.PreviousDigest
	restored.Version = tx.PreviousVersion
	if err := i.wait(ctx, dir, &restored, 3*time.Minute); err != nil {
		_ = report("rollback-failed", "Previous executable restored but startup was not confirmed")
		return errors.Join(cause, err)
	}
	if err := report("rolled-back", cause.Error()); err != nil {
		return err
	}
	return fmt.Errorf("update rolled back: %w", cause)
}
