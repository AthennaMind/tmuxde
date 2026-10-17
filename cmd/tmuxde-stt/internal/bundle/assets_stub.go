//go:build !stt_bundle

package bundle

import "io/fs"

func assets() fs.FS { return nil }
