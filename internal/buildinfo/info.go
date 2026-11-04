// Package buildinfo shares binary compatibility information across commands,
// machine connections and updates. Release version comes from build flags.
package buildinfo

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
)

// ProtocolVersion changes when server, agent or speech wire changes break
// compatibility. Additive changes keep this version. Updates require equality.
const ProtocolVersion = 1

// UpdateProtocol covers supervisor control, readiness and update streams.
// Keep it compatible with parents that stay alive across application updates.
const UpdateProtocol = "update-v1"

type Info struct {
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
	Updater  string `json:"updater"`
}

// Command prints plain version by default, or compatibility details with --json.
func Command(name, version string, args []string, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("version", flag.ContinueOnError)
	flags.SetOutput(stderr)
	structured := flags.Bool("json", false, "print version and compatibility details")
	flags.Usage = func() {
		fmt.Fprintf(stderr, "Usage: %s version [--json]\n", name)
	}
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if flags.NArg() > 0 {
		fmt.Fprintf(stderr, "%s version: unexpected argument %q\n", name, flags.Arg(0))
		return 2
	}
	var err error
	if *structured {
		info := Info{Version: version, Protocol: ProtocolVersion, Updater: UpdateProtocol}
		err = json.NewEncoder(stdout).Encode(info)
	} else {
		_, err = fmt.Fprintln(stdout, version)
	}
	if err != nil {
		fmt.Fprintln(stderr, err)
		return 1
	}
	return 0
}
