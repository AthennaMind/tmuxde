package config

import (
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// Agent contains local node settings and outbound connection credentials.
type Agent struct {
	Node   Config
	URL    string
	Token  string
	CAFile string
}

func LoadAgent(lookup func(string) (string, bool)) (Agent, error) {
	cfg, err := load(lookup, true)
	if err != nil {
		return Agent{}, err
	}
	get := func(k string) string {
		v, _ := lookup(k)
		return strings.TrimSpace(v)
	}
	a := Agent{
		Node:   cfg,
		URL:    get("TMUXDE_SERVER_URL"),
		CAFile: get("TMUXDE_CA_FILE"),
	}
	u, err := url.Parse(a.URL)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return Agent{}, &Error{"TMUXDE_SERVER_URL", "must be an https origin without credentials, query or path"}
	}
	a.URL = strings.TrimRight(a.URL, "/")
	a.Token = get("TMUXDE_AGENT_TOKEN")
	if path := get("TMUXDE_AGENT_TOKEN_FILE"); path != "" {
		if a.Token != "" {
			return Agent{}, &Error{"TMUXDE_AGENT_TOKEN_FILE", "cannot be combined with TMUXDE_AGENT_TOKEN"}
		}
		// Keep credential files inside guarded state directory.
		rel, err := filepath.Rel(cfg.ConfigDir, path)
		if !filepath.IsAbs(path) || err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return Agent{}, &Error{"TMUXDE_AGENT_TOKEN_FILE", "must be inside TMUXDE_CONFIG_DIR"}
		}
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
			return Agent{}, &Error{"TMUXDE_AGENT_TOKEN_FILE", "must be a readable regular file with mode 0600 or 0400"}
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return Agent{}, &Error{"TMUXDE_AGENT_TOKEN_FILE", "cannot read token file"}
		}
		a.Token = strings.TrimSpace(string(b))
	}
	if len(a.Token) < 32 || strings.ContainsAny(a.Token, " \t\r\n") {
		return Agent{}, &Error{"TMUXDE_AGENT_TOKEN", "must be a machine token created by tmuxde machine add"}
	}
	if a.CAFile != "" && !filepath.IsAbs(a.CAFile) {
		return Agent{}, errors.New("TMUXDE_CA_FILE must be an absolute path")
	}
	return a, nil
}
