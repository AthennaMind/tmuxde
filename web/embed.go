// Package web holds the built web app. The build writes it to dist and the
// binary embeds it. Without a build dist holds only .gitkeep, so the embed
// still compiles and Present reports false.
package web

import (
	"embed"
	"io/fs"
)

// files is dist with its dot files. all: keeps the embed valid while dist
// holds only .gitkeep.
//
//go:embed all:dist
var files embed.FS

// Dist returns the build output, rooted at dist.
func Dist() fs.FS {
	sub, err := fs.Sub(files, "dist")
	if err != nil {
		// fs.Sub fails only for an invalid name. "dist" is valid.
		panic(err)
	}
	return sub
}

// Present reports whether the build is embedded, that is whether
// dist/index.html exists.
func Present() bool {
	_, err := fs.Stat(Dist(), "index.html")
	return err == nil
}
