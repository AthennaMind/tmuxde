//go:build stt_bundle

package bundle

import (
	"embed"
	"io/fs"
)

//go:embed models/*
var embedded embed.FS

func assets() fs.FS {
	models, err := fs.Sub(embedded, "models")
	if err != nil {
		panic(err)
	}
	return models
}
