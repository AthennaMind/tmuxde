package files

import (
	"fmt"
	"path/filepath"
	"slices"
	"strings"

	"tmuxde/internal/node"
)

// Guard decides which paths file and repository access may reach.
//
// A path passes when its lexical form and its real form both sit inside an
// allowed root and outside every denied root. The lexical form is the path
// cleaned, with its directories resolved but its last element kept as
// named. The real form follows the last element too. Checking both judges a
// symlink where it lives and where it points. So delete and rename may act
// on the link itself, and a link outside the roots that points inside them
// is still refused. The one exception is an allowed root configured
// through a symlink. Its configured name passes too.
//
// The cleaned path as sent is checked against the deny list as well, so a
// denied directory is refused by name even when it was replaced by a link
// after start.
//
// Allowed roots are resolved again on every call, as the relay did, so a
// root that is created or moved later is followed. Denied roots are
// resolved once by NewGuard. They are process identity, not request state,
// and resolving them per call would put syscalls in the hot loop of a
// listing. Their lexical forms are denied too.
//
// A Guard is safe for concurrent use.
type Guard struct {
	// allowed holds the cleaned absolute roots as configured.
	allowed []string
	// denied holds the resolved and the lexical form of every denied root.
	denied []string
	home   string
}

// NewGuard builds the guard. allowed lists absolute roots. An empty list
// allows nothing. home is the user home and must be absolute. configDir is
// the server state directory. Empty means home/.tmuxde.
//
// The deny list is configDir, ~/.tmuxde, ~/.tmuxremote, ~/.ssh, ~/.aws,
// ~/.gnupg, ~/.config/gh and ~/.kube. It is not configurable on purpose. A
// deny list that can be switched off is one an attacker asks to switch off,
// and nothing in a browser IDE needs to read these through the file API.
// The relay added it after one file:read of ~/.tmuxde/config.json on a
// read only share returned the auth token.
func NewGuard(allowed []string, home, configDir string) (*Guard, error) {
	if home == "" || !filepath.IsAbs(home) {
		return nil, fmt.Errorf("files: home %q must be an absolute path", home)
	}
	home = filepath.Clean(home)
	if configDir == "" {
		configDir = filepath.Join(home, ".tmuxde")
	}
	if !filepath.IsAbs(configDir) {
		return nil, fmt.Errorf("files: config dir %q must be an absolute path", configDir)
	}
	g := &Guard{home: home}
	for _, root := range allowed {
		if root == "" || !filepath.IsAbs(root) {
			return nil, fmt.Errorf("files: allowed path %q must be an absolute path", root)
		}
		g.allowed = append(g.allowed, filepath.Clean(root))
	}
	denied := []string{
		configDir,
		filepath.Join(home, ".tmuxde"),
		filepath.Join(home, ".tmuxremote"),
		filepath.Join(home, ".ssh"),
		filepath.Join(home, ".aws"),
		filepath.Join(home, ".gnupg"),
		filepath.Join(home, ".config", "gh"),
		filepath.Join(home, ".kube"),
	}
	for _, d := range denied {
		d = filepath.Clean(d)
		real, err := realPath(d)
		if err != nil {
			return nil, fmt.Errorf("files: resolve denied root %s: %w", d, err)
		}
		g.denied = append(g.denied, d, real)
	}
	slices.Sort(g.denied)
	g.denied = slices.Compact(g.denied)
	return g, nil
}

// Resolve returns the real absolute path. Missing ancestors are resolved
// one by one up to the first existing one, so a path that does not exist
// yet still resolves. Any errno other than ENOENT is returned as an error.
// The result is node.ErrDenied when the real path or the lexical path is
// outside every allowed root or inside a denied root. Empty and relative
// paths are denied.
func (g *Guard) Resolve(path string) (string, error) {
	_, real, err := g.paths(path)
	return real, err
}

// Allowed reports whether an already resolved path is inside an allowed
// root and outside every denied root.
func (g *Guard) Allowed(path string) bool {
	if path == "" || !filepath.IsAbs(path) {
		return false
	}
	return g.permits(g.roots(), filepath.Clean(path))
}

// paths checks path and returns its lexical and real forms. See Guard for
// both. Errors are node.ErrDenied or the resolution error.
func (g *Guard) paths(path string) (lexical, real string, err error) {
	if path == "" || !filepath.IsAbs(path) {
		return "", "", node.ErrDenied
	}
	clean := filepath.Clean(path)
	if g.isDenied(clean) {
		return "", "", node.ErrDenied
	}
	roots := g.roots()
	lexical, real, err = resolveBoth(clean)
	if err != nil {
		// Only paths that could be inside a root learn why resolution
		// failed. Others get the denial, so errno values do not tell
		// what exists outside the roots.
		if !g.near(roots, clean) {
			return "", "", node.ErrDenied
		}
		return "", "", err
	}
	if (!g.permits(roots, lexical) && !g.isRootName(lexical)) || !g.permits(roots, real) {
		return "", "", node.ErrDenied
	}
	return lexical, real, nil
}

// isRootName reports whether lexical is the name of a configured allowed
// root. A root configured through a symlink, such as /home on Fedora
// Atomic or /tmp on macOS, has a lexical form outside every resolved
// root. Without this the root is denied by its own configured name. Root
// "/" never needs it.
func (g *Guard) isRootName(lexical string) bool {
	if g.isDenied(lexical) {
		return false
	}
	for _, root := range g.allowed {
		if root == "/" {
			continue
		}
		dir, err := realPath(filepath.Dir(root))
		if err != nil {
			continue
		}
		if filepath.Join(dir, filepath.Base(root)) == lexical {
			return true
		}
	}
	return false
}

// resolveBoth returns the lexical and real forms of a clean absolute path.
func resolveBoth(clean string) (lexical, real string, err error) {
	lexical = clean
	if clean != "/" {
		dir, err := realPath(filepath.Dir(clean))
		if err != nil {
			return "", "", err
		}
		lexical = filepath.Join(dir, filepath.Base(clean))
	}
	real, err = realPath(lexical)
	if err != nil {
		return "", "", err
	}
	return lexical, real, nil
}

// roots resolves the allowed roots. A root that fails to resolve is left
// out, so the guard fails closed.
func (g *Guard) roots() []string {
	out := make([]string, 0, len(g.allowed))
	for _, root := range g.allowed {
		if real, err := realPath(root); err == nil {
			out = append(out, real)
		}
	}
	return out
}

// permits reports whether p is inside one of roots and outside the deny
// list.
func (g *Guard) permits(roots []string, p string) bool {
	if g.isDenied(p) {
		return false
	}
	return slices.ContainsFunc(roots, func(root string) bool { return isWithin(p, root) })
}

// near reports whether clean is lexically inside an allowed root, in its
// configured or its resolved form.
func (g *Guard) near(roots []string, clean string) bool {
	within := func(root string) bool { return isWithin(clean, root) }
	return slices.ContainsFunc(g.allowed, within) || slices.ContainsFunc(roots, within)
}

func (g *Guard) isDenied(p string) bool {
	return slices.ContainsFunc(g.denied, func(root string) bool { return isWithin(p, root) })
}

// holdsDenied reports whether p is a denied root or an ancestor of one.
// Denied roots are fixed paths, so moving such a directory would carry
// the denied files out from under the deny list.
func (g *Guard) holdsDenied(p string) bool {
	return slices.ContainsFunc(g.denied, func(root string) bool { return isWithin(root, p) })
}

// isWithin reports whether p is root or below it. Both are clean and
// absolute. The relay rule: equal, or a prefix of root plus a slash. So
// /home/userdata is not inside /home/user. Root "/" holds every path. The
// relay built the prefix "//" there and matched nothing below it.
func isWithin(p, root string) bool {
	if root == "/" {
		return strings.HasPrefix(p, "/")
	}
	return p == root || strings.HasPrefix(p, root+"/")
}

// defaultPath is the first allowed root resolved, else home, else "/".
func (g *Guard) defaultPath() string {
	if len(g.allowed) > 0 {
		if real, err := realPath(g.allowed[0]); err == nil {
			return real
		}
		return g.allowed[0]
	}
	if g.home != "" {
		return g.home
	}
	return "/"
}

// isRoot reports whether real is one of the resolved allowed roots.
func (g *Guard) isRoot(real string) bool {
	return slices.Contains(g.roots(), real)
}
