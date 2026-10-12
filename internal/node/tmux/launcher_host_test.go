package tmux

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"tmuxde/internal/protocol"
)

// launcherChildEnv switches the test binary into runLauncherChild. The
// value is the folder of the host test.
const launcherChildEnv = "TMUXDE_LAUNCHER_CHILD"

// launcherResult is what the child reports to the host test.
type launcherResult struct {
	First, Second string
	Error         string
}

// runLauncherChild stands in for tmuxde.service. It runs inside a
// transient unit, creates two sessions on the socket in dir with the
// default launcher, reports them in result.json and waits to be stopped.
// The first session starts the server. Its command checks that "$" in a
// command reaches the shell unexpanded: systemd-run would replace $X with
// nothing.
func runLauncherChild(dir string) int {
	logFile, err := os.Create(filepath.Join(dir, "child.log"))
	if err != nil {
		return 1
	}
	defer logFile.Close()
	c := New(Options{Socket: filepath.Join(dir, "sock"), Logger: slog.New(slog.NewTextHandler(logFile, nil))})
	ctx := context.Background()
	var res launcherResult
	q := func(name string) string { return "'" + filepath.Join(dir, name) + "'" }
	first, err := c.CreateSession(ctx, "first", "",
		`X=pane-shell; echo "$X" > `+q("expand")+`; env > `+q("first.env")+`; exec sleep 300`)
	if err == nil {
		res.First = first.Name
		var second protocol.SessionInfo
		second, err = c.CreateSession(ctx, "second", "", `env > `+q("second.env")+`; exec sleep 300`)
		res.Second = second.Name
	}
	if err != nil {
		res.Error = err.Error()
	}
	b, _ := json.Marshal(res)
	tmp := filepath.Join(dir, "result.tmp")
	if os.WriteFile(tmp, b, 0o600) != nil || os.Rename(tmp, filepath.Join(dir, "result.json")) != nil {
		return 1
	}
	// The host test stops the unit long before this.
	time.Sleep(3 * time.Minute)
	return 0
}

// TestLauncherSurvivesUnitStop runs on a host with a systemd user manager
// and skips anywhere else, such as in the Docker tooling. It starts this
// test binary as a transient service, which creates a session through the
// default launcher on a private socket, as tmuxde.service would. Then it
// stops that service and checks that the tmux server, both sessions and
// a clean pane environment are still there.
//
// Units are named tmuxde-spike-launcher-<random>, so a leftover from a
// crashed run shows up in systemctl --user list-units 'tmuxde-spike-*'.
// The service also stops itself after three minutes.
func TestLauncherSurvivesUnitStop(t *testing.T) {
	needTmux(t)
	systemdRun, err := exec.LookPath("systemd-run")
	if err != nil {
		t.Skip("systemd-run not on PATH")
	}
	// is-system-running exits 1 for degraded, which is still usable.
	out, _ := exec.Command("systemctl", "--user", "is-system-running").Output()
	if state := strings.TrimSpace(string(out)); state != "running" && state != "degraded" {
		t.Skipf("no systemd user manager, state %q", state)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(dir, "home")
	if err := os.Mkdir(home, 0o700); err != nil {
		t.Fatal(err)
	}
	sock := filepath.Join(dir, "sock")
	var b [4]byte
	_, _ = rand.Read(b[:])
	unit := "tmuxde-spike-launcher-" + hex.EncodeToString(b[:])
	ctx := context.Background()
	// Queries from the test itself never start a server.
	probe := New(Options{Socket: sock, Launcher: LauncherNone, Logger: quiet})

	systemctl := func(args ...string) error {
		return exec.Command("systemctl", append([]string{"--user"}, args...)...).Run()
	}
	t.Cleanup(func() {
		_, _ = probe.run(ctx, "kill-server")
		_ = systemctl("stop", unit+".service")
		// The scope ends with the server. This catches a stray process.
		_ = systemctl("stop", unit+"-tmux-*.scope")
	})

	// HOME is a fresh folder, so the user's tmux.conf stays out. The two
	// settings stand in for the env file. Panes must not get them.
	start := exec.Command(systemdRun, "--user", "--unit="+unit, "--collect", "--quiet",
		"--property=RuntimeMaxSec=180",
		"--working-directory="+dir,
		"--setenv=PATH="+os.Getenv("PATH"),
		"--setenv=HOME="+home,
		"--setenv="+launcherChildEnv+"="+dir,
		"--setenv=TMUXDE_LISTEN=unix:"+filepath.Join(dir, "http.sock"),
		"--setenv=ALLOWED_PATHS="+dir,
		"--", self, "-test.run=^$")
	if out, err := start.CombinedOutput(); err != nil {
		t.Fatalf("systemd-run: %v: %s", err, out)
	}

	var res launcherResult
	poll(t, "child result", 30*time.Second, 50*time.Millisecond, func() (bool, string) {
		b, err := os.ReadFile(filepath.Join(dir, "result.json"))
		if err != nil {
			return false, err.Error()
		}
		return json.Unmarshal(b, &res) == nil, string(b)
	})
	if res.Error != "" || res.First != "first" || res.Second != "second" {
		t.Fatalf("child %+v, log:\n%s", res, readFile(t, filepath.Join(dir, "child.log")))
	}
	log := readFile(t, filepath.Join(dir, "child.log"))
	if strings.Count(log, `msg="starting tmux server in its own scope"`) != 1 {
		t.Fatalf("child log, want one launch:\n%s", log)
	}
	t.Logf("child log:\n%s", log)

	pidOut, err := probe.run(ctx, "display-message", "-p", "#{pid}")
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(pidOut))
	if err != nil {
		t.Fatalf("server pid %q", pidOut)
	}
	cgroup := readFile(t, fmt.Sprintf("/proc/%d/cgroup", pid))
	scope := "/" + unit + "-tmux-"
	if !strings.Contains(cgroup, scope) || !strings.HasSuffix(strings.TrimSpace(cgroup), ".scope") {
		t.Fatalf("server cgroup %q, want a scope %s*", cgroup, scope[1:])
	}
	t.Logf("tmux server %d in %s", pid, strings.TrimSpace(cgroup))

	// Both panes wrote their environment. The first one also shows that
	// "$X" reached its shell.
	poll(t, "pane output", 10*time.Second, 50*time.Millisecond, func() (bool, string) {
		b, _ := os.ReadFile(filepath.Join(dir, "expand"))
		_, err := os.Stat(filepath.Join(dir, "second.env"))
		return err == nil && string(b) == "pane-shell\n", string(b)
	})
	for _, name := range []string{"first.env", "second.env"} {
		env := readFile(t, filepath.Join(dir, name))
		for _, k := range []string{
			"INVOCATION_ID", "JOURNAL_STREAM", "SYSTEMD_EXEC_PID", "MANAGERPID", "MEMORY_PRESSURE_WATCH",
			"TMUXDE_LISTEN", "ALLOWED_PATHS", launcherChildEnv,
		} {
			if hasVar(env, k) {
				t.Errorf("%s has %s", name, k)
			}
		}
		lines := strings.Split(env, "\n")
		for _, kv := range []string{"HOME=" + home, "PATH=" + os.Getenv("PATH")} {
			if !slices.Contains(lines, kv) {
				t.Errorf("%s lacks %s", name, kv)
			}
		}
	}

	if err := systemctl("stop", unit+".service"); err != nil {
		t.Fatalf("stop %s: %v", unit, err)
	}
	if err := systemctl("is-active", "--quiet", unit+".service"); err == nil {
		t.Fatalf("%s still active after stop", unit)
	}
	for _, name := range []string{"first", "second"} {
		if !probe.SessionExists(ctx, name) {
			t.Errorf("session %s is gone after the unit stopped", name)
		}
	}
	after, err := probe.run(ctx, "display-message", "-p", "#{pid}")
	if err != nil || strings.TrimSpace(after) != strconv.Itoa(pid) {
		t.Fatalf("server pid after stop %q, %v, want %d", after, err, pid)
	}
	t.Logf("%s stopped, server %d and sessions first and second still there", unit, pid)
}
