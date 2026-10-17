// Command tmuxde is the tmuxde server. It serves the browser over HTTP and
// WebSocket and drives host tmux.
//
// serve runs standalone mode: one hub and one local node in this process.
// The hub edge answers /health and the old code entry redirects, the
// WebSocket server takes /_relay, GET /file serves downloads through the
// node's path guards, and everything else goes to the web dev server when
// one is set, or else to the web build embedded in the binary. The local
// node drives host tmux, files and repositories.
// With STT_SOCKET set the hub forwards dictation to the speech service on
// that socket and offers it to browsers while its health check passes.
// serve refuses to start when tmux -V fails or the path guard cannot be
// built.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"runtime"
	"sync"
	"syscall"
	"time"

	"tmuxde/internal/config"
	"tmuxde/internal/hub/accesslog"
	"tmuxde/internal/hub/dictation"
	"tmuxde/internal/hub/edge"
	"tmuxde/internal/hub/filehttp"
	"tmuxde/internal/hub/static"
	"tmuxde/internal/hub/ws"
	"tmuxde/internal/machine"
	"tmuxde/internal/node"
	"tmuxde/internal/node/local"
	"tmuxde/internal/protocol/server"
	"tmuxde/web"
)

// version is set at build time: -ldflags "-X main.version=1.2.3".
var version = "dev"

const usage = `Usage: tmuxde <command>

Commands:
  serve     run the server. Configured by environment variables.
  agent     connect this machine to a central server.
  machine   add, list, rotate or revoke machine credentials.
  version   print the version.
`

const serveUsage = `Usage: tmuxde serve

Environment:
  TMUXDE_LISTEN       host:port or unix:/path. Default 127.0.0.1:24200.
                      Host is a loopback or private IP, or localhost.
  TMUXDE_LOCAL_NODE   false runs central server without local tmux. Default true.
  AUTH_TOKEN          shared secret, at least 16 characters. Required.
  ALLOWED_PATHS       comma separated absolute paths for file access. Required.
  CORS_ORIGINS        comma separated browser origins. Required.
  MACHINE_NAME        name the sidebar shows for this machine, 1 to 64
                      characters. Default is the hostname.
  TMUX_SOCKET         tmux socket path. Default is the tmux default.
  TMUX_DEFAULT_SHELL  absolute path of the command for new sessions and
                      windows. Default is the tmux default-command and
                      default-shell.
  TMUXDE_DEV_WEB_URL  web dev server to proxy pages to. Unset serves the
                      web build embedded in the binary.
  STT_SOCKET          unix socket of the speech service. Unset turns
                      dictation off.
  TMUXDE_CONFIG_DIR   state directory, holds access.log.
                      Default ~/.config/tmuxde.
  IDLE_TIMEOUT_MINUTES
                      minutes before an idle browser connection closes.
                      Default 30, 0 disables.
`

// shutdownTimeout bounds each shutdown step: closing the WebSockets, then
// waiting for open HTTP requests.
const shutdownTimeout = 5 * time.Second

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	switch args[0] {
	case "serve":
		return runServe(args[1:], stderr)
	case "agent":
		return runAgent(args[1:], stderr)
	case "machine":
		return runMachine(args[1:], stdout, stderr)
	case "version":
		return runVersion(args[1:], stdout, stderr)
	case "help", "-h", "-help", "--help":
		fmt.Fprint(stdout, usage)
		return 0
	default:
		fmt.Fprintf(stderr, "tmuxde: unknown command %q\n\n%s", args[0], usage)
		return 2
	}
}

// parseFlags parses a subcommand without flags. It returns an exit code
// and false when the command must stop.
func parseFlags(name, help string, args []string, stderr io.Writer) (int, bool) {
	flags := flag.NewFlagSet(name, flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() { fmt.Fprint(stderr, help) }
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0, false
		}
		return 2, false
	}
	if flags.NArg() > 0 {
		fmt.Fprintf(stderr, "tmuxde %s: unexpected argument %q\n", name, flags.Arg(0))
		return 2, false
	}
	return 0, true
}

func runVersion(args []string, stdout, stderr io.Writer) int {
	if code, ok := parseFlags("version", "Usage: tmuxde version\n", args, stderr); !ok {
		return code
	}
	fmt.Fprintln(stdout, version)
	return 0
}

func runServe(args []string, stderr io.Writer) int {
	if code, ok := parseFlags("serve", serveUsage, args, stderr); !ok {
		return code
	}
	started := time.Now()
	logger := slog.New(slog.NewJSONHandler(stderr, nil))

	cfg, err := loadConfig()
	if err != nil {
		logConfigError(logger, err)
		return 1
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	// After the first signal a second one kills the process at once.
	go func() {
		<-ctx.Done()
		stop()
	}()
	return runApp(ctx, cfg, logger, started)
}

// runApp runs standalone mode until ctx ends and returns the exit code.
//
// Order follows the relay. index.ts ran tmux -V and exited before anything
// else, and wire-connections.ts started the session monitor and the clone
// sweep before the HTTP server listened. So the node starts before the
// listener opens: a host without tmux never accepts a browser, and the
// first browser never sees a clone left by a crash.
//
// The node stops after the WebSockets have closed. The monitor polls run
// under ctx, so they end at the signal, before the sockets close, as the
// relay stopped its monitor first. Node.Stop then waits for a monitor
// callback still running. Such a callback can wait on the full queue of a
// stalled browser until that socket closes, so Stop must come after the
// relay shutdown, or one stalled browser would hold the exit.
//
// The speech service probe starts with the node, before the listener, so
// the first browsers can already be offered dictation. It runs under ctx
// as well and stops at the signal, as the relay stopped it first. runApp
// waits for it before it returns.
func runApp(ctx context.Context, cfg config.Config, logger *slog.Logger, started time.Time) int {
	a, err := newApp(cfg, web.Dist(), logger, started)
	if err != nil {
		logger.Error("setup failed", "error", err)
		return 1
	}
	defer a.machines.Close()
	if err := a.startNode(ctx); err != nil {
		if ctx.Err() != nil {
			// A signal during the check. tmux -V was cut short, it did
			// not fail.
			logger.Info("stopped")
			return 0
		}
		logger.Error("node start failed", "error", err)
		return 1
	}
	if a.dictation.Enabled() {
		logger.Info("dictation configured", "sttSocket", cfg.STTSocket)
	} else {
		logger.Info("dictation not configured", "reason", "STT_SOCKET is not set")
	}
	probeCtx, stopProbe := context.WithCancel(ctx)
	probeDone := a.dictation.StartProbe(probeCtx)
	defer func() {
		stopProbe()
		<-probeDone
	}()

	ln, err := listen(cfg.Listen)
	if err != nil {
		a.stopNode()
		logger.Error("listen failed", "listen", cfg.Listen.String(), "error", err)
		return 1
	}
	attrs := []any{"listen", cfg.Listen.String(), "version", version}
	if cfg.DevWebURL != nil {
		attrs = append(attrs, "devWebURL", cfg.DevWebURL.String())
	}
	logger.Info("listening", attrs...)
	err = serve(ctx, ln, a, logger)
	// serve has closed every WebSocket, and with them every pty.
	a.stopNode()
	if err != nil {
		logger.Error("server failed", "error", err)
		return 1
	}
	logger.Info("stopped")
	return 0
}

// loadConfig reads the configuration from the environment. On success it
// drops AUTH_TOKEN from the process environment. Children such as tmux and
// git inherit os.Environ(). A tmux server started by one of them keeps its
// start environment as the global environment, and every pane would inherit
// the token.
func loadConfig() (config.Config, error) {
	cfg, err := config.FromEnv()
	if err != nil {
		return config.Config{}, err
	}
	if err := os.Unsetenv("AUTH_TOKEN"); err != nil {
		return config.Config{}, fmt.Errorf("unset AUTH_TOKEN: %w", err)
	}
	return cfg, nil
}

// logConfigError logs one line per invalid variable.
func logConfigError(logger *slog.Logger, err error) {
	list := []error{err}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		list = joined.Unwrap()
	}
	for _, e := range list {
		var ce *config.Error
		if errors.As(e, &ce) {
			logger.Error("invalid configuration", "variable", ce.Var, "reason", ce.Reason)
		} else {
			logger.Error("invalid configuration", "error", e)
		}
	}
}

// localName is the name browsers show for the local node: MACHINE_NAME
// when set, else the hostname. Info.Hostname stays the real hostname.
func localName(configured, hostname string) string {
	if configured != "" {
		return configured
	}
	return hostname
}

// app is standalone mode: the HTTP side, the local node behind it and
// the dictation bridge to the speech service.
type app struct {
	handler   http.Handler
	relay     *ws.Server
	node      *local.Node
	machines  *machine.Hub
	dictation *dictation.Bridge
}

// newApp builds the local node, the dictation bridge and the hub edge, and
// mounts the WebSocket server on /_relay and the download handler on /file
// in front of the node. site is the web build, see webHandler. Nothing runs
// yet. The node starts with Node.Start, the speech service probe with
// Bridge.StartProbe.
func newApp(cfg config.Config, site fs.FS, logger *slog.Logger, started time.Time) (*app, error) {
	var n *local.Node
	machines := machine.NewHub(cfg.ConfigDir, cfg.AuthToken)
	if !cfg.DisableLocal {
		n = local.New(nodeConfig(cfg), logger)
		machines.Local = n
		machines.LocalFiles = n
		hostname, _ := os.Hostname()
		machines.LocalInfo = machine.Info{
			ID:          "local",
			Name:        localName(cfg.MachineName, hostname),
			Online:      true,
			Hostname:    hostname,
			Platform:    runtime.GOOS,
			DefaultPath: ws.DefaultPath(cfg.AllowedPaths, cfg.Home),
			Version:     version,
			Features:    ws.Features(false),
		}
	}
	// An empty socket gives a bridge that answers every start with
	// UNAVAILABLE and is never offered.
	dict := dictation.New(dictation.Options{SocketPath: cfg.STTSocket, Logger: logger})
	relay, err := ws.New(ws.Options{
		Token:       cfg.AuthToken,
		Origins:     cfg.CORSOrigins,
		DefaultPath: ws.DefaultPath(cfg.AllowedPaths, cfg.Home),
		Resolve: func(id string) (ws.Target, error) {
			// Login authenticates against the hub even when all agents are offline.
			if id == "hub" {
				return ws.Target{
					Info:     server.ServerInfo{Type: "server:info", Platform: runtime.GOOS},
					Features: []string{},
				}, nil
			}
			n, _, info, _, err := machines.Resolve(id)
			if err != nil {
				return ws.Target{}, err
			}
			return ws.Target{
				Node: n,
				Info: server.ServerInfo{
					Type:        "server:info",
					Hostname:    info.Hostname,
					Platform:    info.Platform,
					DefaultPath: &info.DefaultPath,
				},
				Features: info.Features,
			}, nil
		},
		AccessLog:   accesslog.New(cfg.ConfigDir, logger),
		Dictation:   dict,
		IdleTimeout: cfg.IdleTimeout,
		Logger:      logger,
	})
	if err != nil {
		return nil, fmt.Errorf("websocket server: %w", err)
	}
	e := edge.New(edge.Options{
		DevWebURL: cfg.DevWebURL,
		Static:    webHandler(cfg, site, logger),
		Started:   started,
		Logger:    logger,
	})
	e.Handle(ws.Path, relay)
	e.Handle(machine.AgentPath, machines)
	e.Handle(machine.StreamPath, machines)
	e.Handle(machine.MachinesPath, machines)
	// The hub checks the token. The node checks the path and opens the
	// file.
	e.Handle(filehttp.Path, filehttp.New(filehttp.Options{
		Token: cfg.AuthToken,
		Resolve: func(id string) (node.FileOpener, error) {
			_, opener, _, _, err := machines.Resolve(id)
			return opener, err
		},
		Logger: logger,
	}))
	return &app{handler: e, relay: relay, node: n, machines: machines, dictation: dict}, nil
}

func (a *app) startNode(ctx context.Context) error {
	if a.node == nil {
		return nil
	}
	return a.node.Start(ctx)
}

func (a *app) stopNode() {
	if a.node != nil {
		a.node.Stop()
	}
}

// webHandler picks what serves the requests no route claims, and logs the
// choice once. A dev web URL wins: the edge proxies there and site is
// unused. Otherwise site is served. Without index.html in site every page
// answers 503 and that is logged here. On a TCP listener it is an error.
// On a unix socket it is a warning: a reverse proxy may serve pages
// separately. A nil site serves nothing, so the edge answers 404.
func webHandler(cfg config.Config, site fs.FS, logger *slog.Logger) http.Handler {
	present := false
	if site != nil {
		_, err := fs.Stat(site, "index.html")
		present = err == nil
	}
	switch {
	case cfg.DevWebURL != nil:
		logger.Info("web pages from dev server", "devWebURL", cfg.DevWebURL.String(), "embeddedBuild", present)
		return nil
	case site == nil:
		return nil
	case present:
		logger.Info("web build embedded")
	default:
		level := slog.LevelError
		if cfg.Listen.Network == "unix" {
			level = slog.LevelWarn
		}
		logger.Log(context.Background(), level, "web build missing",
			"reason", "the binary has no web/dist/index.html and TMUXDE_DEV_WEB_URL is not set",
			"status", http.StatusServiceUnavailable)
	}
	return static.Handler(site, static.Options{Logger: logger})
}

// nodeConfig is cfg without the token and the origins. Those belong to the
// hub. A node never sees them, so a node log line cannot leak the token.
func nodeConfig(cfg config.Config) config.Config {
	cfg.AuthToken = ""
	cfg.CORSOrigins = nil
	return cfg
}

// listen opens the configured address. A unix socket left by a server that
// died is removed first.
func listen(l config.Listen) (net.Listener, error) {
	if l.Network == "unix" {
		if err := removeStaleSocket(l.Address); err != nil {
			return nil, err
		}
	}
	return net.Listen(l.Network, l.Address)
}

// removeStaleSocket refuses to touch a path that is not a socket or that a
// running server still answers on.
func removeStaleSocket(path string) error {
	info, err := os.Lstat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.Mode().Type() != fs.ModeSocket {
		return fmt.Errorf("%s exists and is not a socket", path)
	}
	if conn, err := net.DialTimeout("unix", path, time.Second); err == nil {
		conn.Close()
		return fmt.Errorf("%s is in use by a running server", path)
	}
	return os.Remove(path)
}

// serve runs the HTTP server on ln until ctx ends. Then it stops
// accepting, closes every WebSocket and waits up to shutdownTimeout for
// open HTTP requests. WebSockets need their own step: the HTTP server
// hands them off at the upgrade and no longer tracks them.
//
// Connections that never sent a request are closed before that wait.
// Browsers open spare connections ahead of time, and so does the Go HTTP
// client when it dials while an earlier connection drains a closed body.
// Shutdown in net/http waits five seconds before it treats such a
// connection as idle. That met shutdownTimeout, so one spare connection
// held the exit for the full five seconds.
func serve(ctx context.Context, ln net.Listener, a *app, logger *slog.Logger) error {
	unused := &unusedConns{conns: map[net.Conn]struct{}{}}
	srv := &http.Server{
		Handler:           a.handler,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ErrorLog:          slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
		ConnState:         unused.track,
	}
	done := make(chan error, 1)
	go func() { done <- srv.Serve(ln) }()

	select {
	case err := <-done:
		// Serve failed on its own. Nothing accepts any more.
		shutdownRelay(a.relay, logger)
		return err
	case <-ctx.Done():
	}
	logger.Info("shutting down")

	// Stop accepting. Serve returns. Open connections stay.
	ln.Close()
	if err := <-done; err != nil && !errors.Is(err, net.ErrClosed) && !errors.Is(err, http.ErrServerClosed) {
		logger.Warn("listener stopped with an error", "error", err)
	}
	shutdownRelay(a.relay, logger)
	if a.machines != nil {
		a.machines.Close()
	}

	// Serve has returned, so every accepted connection is tracked.
	unused.closeAll()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		// A request that outlives the timeout is cut. That does not make
		// the exit a failure.
		logger.Warn("closing open HTTP connections", "error", err)
		srv.Close()
	}
	return nil
}

// unusedConns tracks the connections that have not sent a request yet.
type unusedConns struct {
	mu    sync.Mutex
	conns map[net.Conn]struct{}
}

// track is the http.Server ConnState hook. A connection leaves the set on
// its first request, on hijack and on close.
func (u *unusedConns) track(c net.Conn, state http.ConnState) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if state == http.StateNew {
		u.conns[c] = struct{}{}
		return
	}
	delete(u.conns, c)
}

// closeAll closes every connection still waiting for its first request.
// A request that was arriving on one is cut, as srv.Close would cut it.
func (u *unusedConns) closeAll() {
	u.mu.Lock()
	defer u.mu.Unlock()
	for c := range u.conns {
		c.Close()
	}
	clear(u.conns)
}

// shutdownRelay closes every WebSocket with 1001 and waits for their close
// paths, up to shutdownTimeout.
func shutdownRelay(relay *ws.Server, logger *slog.Logger) {
	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := relay.Shutdown(ctx); err != nil {
		logger.Warn("websocket shutdown incomplete", "error", err)
	}
}
