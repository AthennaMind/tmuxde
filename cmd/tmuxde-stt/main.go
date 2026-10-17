// Command tmuxde-stt is the speech to text service behind tmuxde
// dictation. It listens on the unix socket STT_SOCKET only and decodes
// with Parakeet TDT through sherpa-onnx, one utterance at a time when a
// Silero VAD model is set. See internal/stt/README.md.
//
// serve, the default, loads the models and runs until SIGTERM or SIGINT.
// health asks a running service for GET /health over the socket and exits
// 0 only on 200, for the container health check. version prints the
// version.
//
// The speech engine is a cgo binding that only builds with -tags sherpa.
// Any other build refuses to serve and says how to build it.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"tmuxde/cmd/tmuxde-stt/internal/bundle"
	"tmuxde/internal/stt"
	"tmuxde/internal/stt/sherpa"
)

// version is set at build time: -ldflags "-X main.version=1.2.3".
var version = "dev"

const usage = `Usage: tmuxde-stt [command]

Commands:
  serve     run the service, the default. Configured by environment variables.
  health    check the running service over STT_SOCKET. Exit 0 when healthy.
  version   print the version.
`

const serveUsage = `Usage: tmuxde-stt serve

Environment:
  STT_SOCKET        unix socket to listen on. Absolute, at most 107 bytes.
                    Required.
  STT_MODEL_DIR     folder with encoder.int8.onnx, decoder.int8.onnx,
                    joiner.int8.onnx and tokens.txt. Releases bundle defaults.
  STT_VAD_MODEL     path to silero_vad.onnx. Bundled by default in releases.
  XDG_CACHE_HOME    extracted model cache. Default is user cache directory.
  STT_THREADS       threads per decode, 1 to 64. Default 4.
  STT_MAX_SESSIONS  dictations at once, 1 to 64. Default 4.
  STT_MAX_SECONDS   audio per dictation, 10 to 3600. Default 600.
`

const healthUsage = `Usage: tmuxde-stt health

Sends GET /health to the service on STT_SOCKET. Exits 0 on 200, else 1.
`

// shutdownTimeout bounds the exit after a signal, as in the Node service.
const shutdownTimeout = 2 * time.Second

// healthTimeout stays under the 3 s timeout of the image health check.
const healthTimeout = 2 * time.Second

func main() {
	os.Exit(run(os.Args[1:], os.LookupEnv, os.Stdout, os.Stderr))
}

func run(args []string, lookup func(string) (string, bool), stdout, stderr io.Writer) int {
	cmd := "serve"
	if len(args) > 0 {
		cmd, args = args[0], args[1:]
	}
	switch cmd {
	case "serve":
		if code, ok := parseFlags("serve", serveUsage, args, stderr); !ok {
			return code
		}
		return runServe(lookup, stdout)
	case "health":
		if code, ok := parseFlags("health", healthUsage, args, stderr); !ok {
			return code
		}
		return runHealth(lookup, stderr)
	case "version":
		if code, ok := parseFlags("version", "Usage: tmuxde-stt version\n", args, stderr); !ok {
			return code
		}
		fmt.Fprintln(stdout, version)
		return 0
	case "help", "-h", "-help", "--help":
		fmt.Fprint(stdout, usage)
		return 0
	default:
		fmt.Fprintf(stderr, "tmuxde-stt: unknown command %q\n\n%s", cmd, usage)
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
		fmt.Fprintf(stderr, "tmuxde-stt %s: unexpected argument %q\n", name, flags.Arg(0))
		return 2, false
	}
	return 0, true
}

// runServe loads the models, then serves until SIGTERM or SIGINT. Logs
// are JSON lines on stdout. They never hold audio or text.
func runServe(lookup func(string) (string, bool), stdout io.Writer) int {
	logger := slog.New(slog.NewJSONHandler(stdout, nil))
	cfg, err := loadConfig(lookup)
	if err != nil {
		logConfigError(logger, err)
		return 1
	}

	// Like the Node service, signals keep their default until the models
	// are loaded. A load cannot be cut short anyway.
	started := time.Now()
	transcriber, newSegmenter, err := loadEngine(cfg)
	if err != nil {
		logger.Error("Startup failed", "error", err.Error())
		return 1
	}
	segments := "30 s chunks"
	if newSegmenter != nil {
		segments = "utterances"
	}
	model := filepath.Base(cfg.ModelDir)
	logger.Info("Model loaded",
		"model", model,
		"threads", cfg.Threads,
		"segments", segments,
		"ms", time.Since(started).Milliseconds(),
	)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	return serve(ctx, cfg, stt.ServerOptions{
		Transcriber:  transcriber,
		Model:        model,
		MaxSessions:  cfg.MaxSessions,
		Limits:       stt.SessionLimits{MaxSeconds: cfg.MaxSeconds, Idle: stt.DefaultIdle},
		NewSegmenter: newSegmenter,
		Logger:       logger,
	})
}

// loadConfig validates settings before extracting release defaults.
func loadConfig(lookup func(string) (string, bool)) (stt.Config, error) {
	model, _ := lookup("STT_MODEL_DIR")
	useBundle := model == "" && bundle.Available()
	cfg, err := stt.LoadConfig(func(key string) (string, bool) {
		if key == "STT_MODEL_DIR" && useBundle {
			return "embedded", true
		}
		return lookup(key)
	})
	if err != nil || !useBundle {
		return cfg, err
	}
	cfg.ModelDir, err = bundle.Extract()
	if err != nil {
		return cfg, fmt.Errorf("extract speech models: %w", err)
	}
	if _, set := lookup("STT_VAD_MODEL"); !set {
		cfg.VADModel = filepath.Join(cfg.ModelDir, "silero_vad.onnx")
	}
	return cfg, nil
}

// serve listens on cfg.Socket and runs the server until ctx ends. Then it
// closes the server, which drops every session and removes the socket,
// and returns 0 within shutdownTimeout.
func serve(ctx context.Context, cfg stt.Config, opts stt.ServerOptions) int {
	logger := opts.Logger
	srv := stt.NewServer(opts)
	ln, err := stt.Listen(cfg.Socket)
	if err != nil {
		logger.Error("Listen failed", "socket", cfg.Socket, "error", err.Error())
		return 1
	}
	served := make(chan error, 1)
	go func() { served <- srv.Serve(ln) }()
	logger.Info("Speech service listening", "socket", cfg.Socket)

	select {
	case err := <-served:
		srv.Close()
		logger.Error("Server failed", "error", err.Error())
		return 1
	case <-ctx.Done():
	}
	closed := make(chan struct{})
	go func() {
		defer close(closed)
		srv.Close()
	}()
	select {
	case <-closed:
	case <-time.After(shutdownTimeout):
		logger.Warn("Shutdown timed out")
	}
	logger.Info("Stopped")
	return 0
}

// loadEngine loads Parakeet and, with STT_VAD_MODEL set, checks the
// Silero model. A nil segmenter factory means 30 s chunks. Model files
// are checked before the engine, so a missing file is named even in a
// build without the binding.
func loadEngine(cfg stt.Config) (stt.Transcriber, func() (stt.Segmenter, error), error) {
	if err := stt.CheckModelFiles(cfg.ModelDir); err != nil {
		return nil, nil, err
	}
	var newSegmenter func() (stt.Segmenter, error)
	if cfg.VADModel != "" {
		var err error
		newSegmenter, err = stt.LoadVADSegmenter(cfg.VADModel, openVAD)
		if err != nil {
			return nil, nil, err
		}
	}
	rec, err := sherpa.NewRecognizer(sherpa.RecognizerConfig{
		Encoder:    filepath.Join(cfg.ModelDir, stt.EncoderFile),
		Decoder:    filepath.Join(cfg.ModelDir, stt.DecoderFile),
		Joiner:     filepath.Join(cfg.ModelDir, stt.JoinerFile),
		Tokens:     filepath.Join(cfg.ModelDir, stt.TokensFile),
		Threads:    cfg.Threads,
		SampleRate: stt.SampleRate,
	})
	if err != nil {
		return nil, nil, err
	}
	return stt.Serialize(rec.Decode), newSegmenter, nil
}

// openVAD opens one Silero detector. Each session owns one.
func openVAD(model string) (stt.VAD, error) {
	vad, err := sherpa.NewVAD(sherpa.VADConfig{Model: model, SampleRate: stt.SampleRate})
	if err != nil {
		return nil, err
	}
	return vad, nil
}

// logConfigError logs one line per invalid variable.
func logConfigError(logger *slog.Logger, err error) {
	list := []error{err}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		list = joined.Unwrap()
	}
	for _, e := range list {
		var ce *stt.ConfigError
		if errors.As(e, &ce) {
			logger.Error("Invalid configuration", "variable", ce.Var, "reason", ce.Reason)
		} else {
			logger.Error("Invalid configuration", "error", e.Error())
		}
	}
}

// runHealth asks the service on STT_SOCKET for GET /health.
func runHealth(lookup func(string) (string, bool), stderr io.Writer) int {
	socket, _ := lookup("STT_SOCKET")
	if socket == "" {
		fmt.Fprintln(stderr, "tmuxde-stt health: STT_SOCKET is not set")
		return 1
	}
	client := &http.Client{
		Timeout: healthTimeout,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", socket)
			},
			DisableKeepAlives: true,
		},
	}
	// The host part is never resolved. The dialer ignores it.
	resp, err := client.Get("http://stt" + stt.HealthPath)
	if err != nil {
		fmt.Fprintf(stderr, "tmuxde-stt health: %v\n", err)
		return 1
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(stderr, "tmuxde-stt health: status %d\n", resp.StatusCode)
		return 1
	}
	return 0
}
