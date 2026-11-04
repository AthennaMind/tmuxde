package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"

	"tmuxde/internal/config"
	"tmuxde/internal/hub/ws"
	"tmuxde/internal/machine"
	"tmuxde/internal/node/local"
	"tmuxde/internal/update"
	"tmuxde/internal/update/ready"
)

const agentUsage = `Usage: tmuxde agent

Environment:
  TMUXDE_SERVER_URL       central server https origin. Required.
  TMUXDE_AGENT_TOKEN_FILE token file inside TMUXDE_CONFIG_DIR, mode 0600.
  TMUXDE_AGENT_TOKEN      token instead of a token file.
  TMUXDE_CA_FILE          optional PEM certificate for the server CA.
  TMUXDE_CONFIG_DIR       state directory. Default ~/.config/tmuxde.
  ALLOWED_PATHS          comma separated absolute paths. Required.
  TMUX_SOCKET            optional tmux socket path.
  TMUX_DEFAULT_SHELL     optional shell for new sessions.
  TMUXDE_TMUX_LAUNCHER   auto, systemd-run or none. Default auto.
`

func runAgent(args []string, stderr io.Writer) int {
	if code, ok := parseFlags("agent", agentUsage, args, stderr); !ok {
		return code
	}
	logger := slog.New(slog.NewJSONHandler(stderr, nil))
	cfg, err := config.LoadAgent(os.LookupEnv)
	if err != nil {
		logConfigError(logger, err)
		return 1
	}
	// No token reaches tmux, git or pane processes through the environment.
	for _, name := range []string{"AUTH_TOKEN", "TMUXDE_AGENT_TOKEN", "TMUXDE_AGENT_TOKEN_FILE"} {
		if err := os.Unsetenv(name); err != nil {
			logger.Error("clear credential environment", "variable", name)
			return 1
		}
	}
	ctx, stop := ready.Context(context.Background())
	defer stop()
	go func() {
		<-ctx.Done()
		stop()
	}()

	n := local.New(cfg.Node, logger)
	if err := n.Start(ctx); err != nil {
		logger.Error("node start failed", "error", err)
		return 1
	}
	defer n.Stop()
	hostname, _ := os.Hostname()
	updater := update.NewHost("agent", hostname, "agent", version)
	updateInfo := updater.Info(ctx)
	agent := &machine.Agent{
		OnReady: func() {
			if err := ready.Mark(version); err != nil {
				logger.Warn("update startup receipt failed", "error", err)
			}
		},
		Updater: updater,
		URL:     cfg.URL,
		Token:   cfg.Token,
		CAFile:  cfg.CAFile,
		Node:    n,
		Files:   n,
		Logger:  logger,
		Info: machine.Info{
			Update:      &updateInfo,
			Hostname:    hostname,
			Platform:    runtime.GOOS,
			DefaultPath: ws.DefaultPath(cfg.Node.AllowedPaths, cfg.Node.Home),
			Version:     version,
			Features:    append(ws.Features(false), update.Feature),
		},
	}
	if err := agent.Run(ctx); err != nil {
		logger.Error("agent failed", "error", err)
		return 1
	}
	return 0
}

const machineUsage = `Usage: tmuxde machine <operation> [value]

Operations:
  add <name>    create a machine and print its token once.
  list          list registered machines without credentials.
  rotate <id>   replace credential and print new token once.
  revoke <id>   disconnect machine and disable its credential.

Uses TMUXDE_CONFIG_DIR, default ~/.config/tmuxde.
`

func runMachine(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, machineUsage)
		return 2
	}
	dir := os.Getenv("TMUXDE_CONFIG_DIR")
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			fmt.Fprintln(stderr, "Cannot find home directory")
			return 1
		}
		dir = filepath.Join(home, ".config", "tmuxde")
	}
	if !filepath.IsAbs(dir) {
		fmt.Fprintln(stderr, "TMUXDE_CONFIG_DIR must be an absolute path")
		return 1
	}
	if args[0] == "list" && len(args) == 1 {
		records, err := machine.Records(dir)
		if err != nil {
			fmt.Fprintln(stderr, err)
			return 1
		}
		for _, record := range records {
			status := "enabled"
			if record.Revoked {
				status = "revoked"
			}
			fmt.Fprintf(stdout, "%s\t%s\t%s\n", record.ID, status, record.Name)
		}
		return 0
	}
	if len(args) != 2 || (args[0] != "add" && args[0] != "rotate" && args[0] != "revoke") {
		fmt.Fprint(stderr, machineUsage)
		return 2
	}
	record, token, err := machine.Edit(dir, args[0], args[1])
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	fmt.Fprintf(stderr, "Machine %s: %s\n", record.ID, record.Name)
	if token != "" {
		// stdout can be redirected straight to a protected credential file.
		fmt.Fprintln(stdout, token)
	}
	return 0
}
