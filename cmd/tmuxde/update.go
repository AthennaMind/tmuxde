package main

import (
	"runtime"

	"tmuxde/internal/config"
	"tmuxde/internal/machine"
	"tmuxde/internal/update"
)

func newUpdater(cfg config.Config, machines *machine.Hub) (*update.Manager, error) {
	host := update.NewHost("server", "Server", "server", version)
	speech := &update.Speech{
		Socket: cfg.STTSocket,
		Host: update.Host{
			Component: update.Component{
				ID:     "speech",
				Name:   "Speech",
				Kind:   "speech",
				OS:     runtime.GOOS,
				Arch:   runtime.GOARCH,
				Online: true,
			},
		},
	}
	return update.NewManager(cfg.ConfigDir, func() []update.Target {
		targets := []update.Target{host}
		targets = append(targets, machines.UpdateTargets()...)
		if cfg.STTSocket != "" {
			targets = append(targets, speech)
		}
		return targets
	})
}
