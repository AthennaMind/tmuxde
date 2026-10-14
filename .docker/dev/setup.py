#!/usr/bin/env python3
"""Write root .env, the token and the run directory for the Docker stack.

With --host-service, install the tmuxde binary as a systemd user service instead.
"""

import argparse
import hashlib
import os
import platform
from pathlib import Path
import pwd
import re
import secrets
import shutil
import subprocess
import tempfile
from types import SimpleNamespace
import urllib.request


NETWORK_KEYS = ("LOCAL_DOMAIN", "LOCAL_BIND_IP")

# Run directory for unix sockets. The key name predates the other sockets.
# http.sock is the host tmuxde binary. dev/http-dev.sock is server-dev.
# stt/stt.sock is the speech service. Caddy mounts the whole directory read
# only. stt and server-dev mount only their subdirs.
SOCKET_DIR_KEY = "LOCAL_STT_SOCKET_DIR"
SOCKETS = ("http.sock", "dev/http-dev.sock", "stt/stt.sock")
STT_SOCKET = "stt/stt.sock"
# Linux sun_path is 108 bytes including the closing NUL.
MAX_SOCKET_PATH_BYTES = 107

# Dictation models. Pinned revisions, every file checked by size and SHA-256.
# Parakeet transcribes. Silero finds the pauses between utterances.
MODELS = {
    "parakeet-tdt-0.6b-v3-int8": (
        "https://huggingface.co/csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8"
        "/resolve/2bda32ec70b097a55adaa07d9a7173915b43cc78/{name}",
        (
            ("encoder.int8.onnx", 652_184_281, "acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247"),
            ("decoder.int8.onnx", 11_845_275, "179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e"),
            ("joiner.int8.onnx", 6_355_277, "3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3"),
            ("tokens.txt", 93_939, "d58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d"),
        ),
    ),
    "silero-vad": (
        "https://huggingface.co/csukuangfj/vad/resolve/fba88cd2e921609e7675c3aaf51e0b9b295da4bc/{name}",
        (
            ("silero_vad.onnx", 1_807_522, "a35ebf52fd3ce5f1469b2a36158dba761bc47b973ea3382b3186ca15b1f5af28"),
        ),
    ),
}


def read_env(env_path):
    values = {}
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            key, sep, value = line.partition("=")
            if sep:
                value = value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                    value = value[1:-1]
                values[key] = value.replace("\\'", "'")
    return values


def network_settings(previous):
    """Keep domain and bind address across reruns. Shell environment wins."""
    kept = {key: previous[key] for key in NETWORK_KEYS if key in previous}
    for key in NETWORK_KEYS:
        if os.environ.get(key):
            kept[key] = os.environ[key]
    return {key: value for key, value in kept.items() if value}


def check_socket_paths(directory):
    for name in SOCKETS:
        if len(os.fsencode(directory / name)) > MAX_SOCKET_PATH_BYTES:
            raise SystemExit(f"{SOCKET_DIR_KEY} is too long for a unix socket path: {directory}")


def stt_socket_dir(previous):
    """Keep the run directory across reruns. Shell environment wins.

    Creates it and its dev and stt subdirs on every run, also with dictation
    off. Caddy mounts the directory. server-dev mounts dev read write and stt
    read only. stt mounts stt. Docker would create a missing bind source as
    root, so Compose refuses to and setup does it.
    """
    value = os.environ.get(SOCKET_DIR_KEY) or previous.get(SOCKET_DIR_KEY)
    directory = Path(value).expanduser() if value else Path.home() / ".local" / "state" / "tmuxde" / "run"
    directory = directory.resolve()
    check_socket_paths(directory)
    private_dir(directory, 0o750)
    private_dir(directory / "dev", 0o750)
    private_dir(directory / "stt", 0o750)
    return directory


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def ensure_model(directory, url, files):
    """Download missing or damaged model files. Nothing is kept unverified."""
    directory.mkdir(parents=True, exist_ok=True, mode=0o755)
    for name, size, expected in files:
        path = directory / name
        if path.is_file() and path.stat().st_size == size and sha256(path) == expected:
            continue
        print(f"Downloading {name} ({size / 1e6:.0f} MB)")
        digest = hashlib.sha256()
        received = 0
        with tempfile.NamedTemporaryFile(dir=directory, prefix=f".{name}.", delete=False) as part:
            staged = Path(part.name)
            try:
                with urllib.request.urlopen(url.format(name=name), timeout=60) as response:
                    for block in iter(lambda: response.read(1 << 20), b""):
                        part.write(block)
                        digest.update(block)
                        received += len(block)
                if received != size or digest.hexdigest() != expected:
                    raise SystemExit(f"{name} failed its checksum. Nothing was installed.")
                part.flush()
                os.fchmod(part.fileno(), 0o644)
            except BaseException:
                staged.unlink(missing_ok=True)
                raise
        staged.replace(path)


def dictation_settings(enabled):
    """Compose profile, models and threads for the optional speech service.

    stt creates its socket in the stt subdir that stt_socket_dir makes.
    """
    if not enabled:
        return {}
    root = (Path.home() / ".local" / "share" / "tmuxde" / "models").resolve()
    for name, (url, files) in MODELS.items():
        ensure_model(root / name, url, files)
    print(f"Dictation models ready: {root}")
    # Eight threads is where the benchmark stopped getting faster.
    threads = max(1, min(8, (os.cpu_count() or 2) // 2))
    return {
        "COMPOSE_PROFILES": "dictation",
        "LOCAL_STT_MODELS": str(root),
        "STT_THREADS": str(threads),
    }



# Host service. The tmuxde Go server runs on the host as a systemd user unit
# and listens on http.sock in the socket directory, where Caddy reaches it.
SERVICE = "tmuxde.service"
BUILD_COMMAND = (
    "docker build -f .docker/prod/tmuxde.Dockerfile --target binary"
    " --output type=local,dest=.docker/bin ."
)
TOKEN_FORMAT = re.compile(r"[0-9a-f]{64}")
# Values written without quotes in the env file.
PLAIN_VALUE = re.compile(r"[A-Za-z0-9_@%+=:,./-]+")
# Directories allowed in the unit PATH. No % since systemd expands it there.
UNIT_PATH_DIR = re.compile(r"/[A-Za-z0-9_@+=,./-]*")
# System part of the unit PATH, as in /etc/environment and the user manager
# on Ubuntu. The unit PATH replaces the manager PATH, and a tmux server
# started by tmuxde hands it to every pane. Without sbin, panes miss sysctl,
# ufw, iptables and visudo.
SYSTEM_PATH = (
    "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin",
    "/usr/games", "/usr/local/games", "/snap/bin",
)
MASKED_TOKEN = "<hidden, 64 hex characters from .docker/.env.token>"


def host_paths(home):
    """Where the host service lives. Same places as %h paths in the unit."""
    bin_dir = home / ".local" / "bin"
    config_dir = home / ".config" / "tmuxde"
    unit_dir = home / ".config" / "systemd" / "user"
    return SimpleNamespace(
        home=home,
        bin_dir=bin_dir,
        binary=bin_dir / "tmuxde",
        previous=bin_dir / "tmuxde.previous",
        config_dir=config_dir,
        env_file=config_dir / "tmuxde.env",
        unit_dir=unit_dir,
        unit=unit_dir / SERVICE,
        dropins=unit_dir / f"{SERVICE}.d",
    )


def tmux_socket_setting(environ, uid):
    """TMUX_SOCKET from the shell that runs setup, or None for the tmux default.

    Unset in the shell means the default server, the one shells use. The
    default socket path stays unset too. Only without -S does tmux create
    /tmp/tmux-<uid> itself, and a reboot clears /tmp. With -S and that
    directory missing, new-session fails.
    """
    value = environ.get("TMUX_SOCKET")
    if not value:
        return None
    socket = Path(value)
    if not socket.is_absolute() or socket.name in ("", ".", ".."):
        raise SystemExit("TMUX_SOCKET must be an absolute socket path.")
    default = Path("/tmp") / f"tmux-{uid}" / "default"
    if socket in (default, default.resolve()):
        return None
    return str(socket)


def host_settings(root, home):
    """Server settings from root .env, the token file and TMUX_SOCKET in the shell.

    Keys that older setups wrote, such as STT_URL, LOCAL_TMUX_DIR and
    LOCAL_TMUX_SOCKET, are ignored.
    """
    env_path = root / ".env"
    if not env_path.is_file():
        raise SystemExit("Root .env is missing. Run scripts/setup.sh first.")
    env = read_env(env_path)
    missing = [key for key in ("LOCAL_HOST_HOME", "LOCAL_UPLOAD_DIR", SOCKET_DIR_KEY) if not env.get(key)]
    if missing:
        raise SystemExit(f"Root .env lacks {', '.join(missing)}. Run scripts/setup.sh first.")

    token_path = root / ".docker" / ".env.token"
    token = token_path.read_text().strip() if token_path.is_file() else ""
    if not TOKEN_FORMAT.fullmatch(token):
        raise SystemExit("Missing or invalid .docker/.env.token. Run scripts/setup.sh first.")

    paths = {key: Path(env[key]) for key in ("LOCAL_HOST_HOME", "LOCAL_UPLOAD_DIR", SOCKET_DIR_KEY)}
    for key, path in paths.items():
        if not path.is_absolute() or "," in str(path):
            raise SystemExit(f"{key} in root .env must be an absolute path without commas.")
    host_home = paths["LOCAL_HOST_HOME"]
    if host_home.resolve() != home.resolve():
        raise SystemExit(f"Root .env was written for {host_home}, not {home}. Run scripts/setup.sh as this user.")
    socket_dir = paths[SOCKET_DIR_KEY]
    check_socket_paths(socket_dir)

    domain = env.get("LOCAL_DOMAIN") or "localhost"
    if not re.fullmatch(r"[A-Za-z0-9.-]+", domain):
        raise SystemExit("LOCAL_DOMAIN in root .env must be a host name or IPv4 address.")
    profiles = [item.strip() for item in env.get("COMPOSE_PROFILES", "").split(",")]
    dictation = "dictation" in profiles

    values = {
        "AUTH_TOKEN": token,
        # Upload dir first, as in Compose. Photo uploads use the first entry.
        "ALLOWED_PATHS": f"{paths['LOCAL_UPLOAD_DIR']},{host_home}",
        "CORS_ORIGINS": f"https://{domain}",
        "TMUXDE_LISTEN": f"unix:{socket_dir / 'http.sock'}",
    }
    tmux_socket = tmux_socket_setting(os.environ, os.getuid())
    if tmux_socket:
        values["TMUX_SOCKET"] = tmux_socket
    if dictation:
        values["STT_SOCKET"] = str(socket_dir / STT_SOCKET)
    values["TMUXDE_CONFIG_DIR"] = str(host_paths(home).config_dir)
    values["HOME"] = str(home)
    return SimpleNamespace(values=values, socket_dir=socket_dir, dictation=dictation)


def render_env(values, masked):
    """Env file for systemd EnvironmentFile. masked hides the token."""
    if "TMUX_SOCKET" in values:
        tmux_note = "# TMUX_SOCKET comes from the shell that ran the script."
    else:
        tmux_note = "# TMUX_SOCKET is unset. tmux uses its default server, the one shells use."
    lines = [
        "# tmuxde server settings, read by the tmuxde.service user unit.",
        "# scripts/setup.sh --host-service writes this file from root .env and",
        "# .docker/.env.token. Rerunning the script rewrites it. Mode 0600.",
        tmux_note,
        "# IDLE_TIMEOUT_MINUTES is unset. Idle browser connections close after 30.",
    ]
    for key, value in values.items():
        if masked and key == "AUTH_TOKEN":
            lines.append(f"{key}={MASKED_TOKEN}")
            continue
        if "\n" in value or "\r" in value:
            raise SystemExit(f"{key} must fit on one line.")
        if PLAIN_VALUE.fullmatch(value):
            lines.append(f"{key}={value}")
        elif "'" in value or "\\" in value:
            raise SystemExit(f"{key} must not contain quotes or backslashes: {value}")
        else:
            # Single quotes keep spaces. systemd takes the content as is.
            lines.append(f"{key}='{value}'")
    return "\n".join(lines) + "\n"


def service_path():
    """PATH for the unit. tmux and git directories first, as this shell finds them.

    The system directories follow. Panes of a tmux server that tmuxde starts
    get this PATH, and login shells only add to it.
    """
    directories = []
    for tool in ("tmux", "git"):
        found = shutil.which(tool)
        if not found:
            raise SystemExit(f"{tool} is not on PATH. Install it, then rerun.")
        directories.append(str(Path(found).absolute().parent))
    directories += SYSTEM_PATH
    directories = list(dict.fromkeys(directories))
    for directory in directories:
        if not UNIT_PATH_DIR.fullmatch(directory):
            raise SystemExit(f"Unit PATH cannot hold {directory}. Move tmux or git to a plain path.")
    return ":".join(directories)


def render_unit(root, path):
    """User unit from the template in .docker/host."""
    template = (root / ".docker" / "host" / SERVICE).read_text()
    if template.count("@PATH@") != 1:
        raise SystemExit(f".docker/host/{SERVICE} must hold @PATH@ exactly once.")
    return template.replace("@PATH@", path)


def binary_version(binary):
    """Run the binary once. Proves it starts on this host."""
    try:
        result = subprocess.run([str(binary), "version"], capture_output=True, text=True, timeout=10)
    except OSError as error:
        raise SystemExit(f"{binary} does not run on this host: {error}")
    if result.returncode != 0:
        raise SystemExit(f"{binary} version failed: {result.stderr.strip()}")
    return result.stdout.strip() or "unknown"


def binary_state(source, paths):
    if not paths.binary.is_file():
        return "new"
    return "unchanged" if sha256(paths.binary) == sha256(source) else "update"


def write_atomic(path, content, mode):
    """Write through a temp file in the same directory, then rename.
    Returns True when the content differs from what was there."""
    changed = not path.is_file() or path.read_text() != content
    descriptor, temp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "w") as file:
            file.write(content)
            file.flush()
            os.fsync(file.fileno())
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise
    return changed


def private_dir(path, mode):
    """Create path with mode, or fix the mode of an existing one we own."""
    path.mkdir(parents=True, exist_ok=True, mode=mode)
    if path.stat().st_uid != os.getuid():
        raise SystemExit(f"{path} must be owned by current user.")
    path.chmod(mode)


def install_binary(source, paths, state):
    """install -m 0755 to a temp name, then rename over the target. A changed
    binary keeps the one it replaces as tmuxde.previous for rollback."""
    if state == "unchanged":
        paths.binary.chmod(0o755)
        return
    paths.bin_dir.mkdir(parents=True, exist_ok=True)
    staged = paths.bin_dir / f".tmuxde.{os.getpid()}.new"
    try:
        subprocess.run(["install", "-m", "0755", str(source), str(staged)], check=True)
        if state == "update":
            # A hard link keeps the target in place until the final rename.
            link = paths.bin_dir / f".tmuxde.{os.getpid()}.previous"
            link.unlink(missing_ok=True)
            try:
                os.link(paths.binary, link)
            except OSError:
                shutil.copy2(paths.binary, link)
            os.replace(link, paths.previous)
        os.replace(staged, paths.binary)
    finally:
        staged.unlink(missing_ok=True)


def systemctl(*args, check=True, quiet=False):
    command = ["systemctl", "--user", *args]
    result = subprocess.run(command, text=True, capture_output=quiet)
    if check and result.returncode != 0:
        raise SystemExit(f"{' '.join(command)} failed with exit code {result.returncode}.")
    return result


def linger_enabled():
    """True, False, or None when loginctl cannot tell."""
    user = pwd.getpwuid(os.getuid()).pw_name
    try:
        result = subprocess.run(
            ["loginctl", "show-user", user, "--property=Linger", "--value"],
            capture_output=True, text=True, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    if result.returncode != 0:
        return None
    return result.stdout.strip() == "yes"


def print_linger_note():
    user = pwd.getpwuid(os.getuid()).pw_name
    linger = linger_enabled()
    if linger:
        print("Linger is on. The service runs from boot and survives logout.")
        return
    state = "off" if linger is False else "unknown"
    print(f"Linger is {state}. Without it the user manager stops at your last logout,")
    print("and tmuxde with it. It starts again only at your next login. Run once,")
    print("it may ask for your password:")
    print(f"  loginctl enable-linger {user}")


def install_host_service(root, dry_run):
    if platform.system() != "Linux":
        raise SystemExit("Host service needs Linux with systemd.")
    if os.geteuid() == 0:
        raise SystemExit("Run as the user who owns the tmux sessions, not as root.")
    source = root / ".docker" / "bin" / "tmuxde"
    if not source.is_file():
        raise SystemExit(f"{source} is missing. Build it from the repository root:\n  {BUILD_COMMAND}")
    for tool in ("systemctl", "install"):
        if not shutil.which(tool):
            raise SystemExit(f"{tool} is not on PATH. Host service needs systemd and coreutils.")

    home = Path.home()
    paths = host_paths(home)
    settings = host_settings(root, home)
    path = service_path()
    unit = render_unit(root, path)
    version = binary_version(source)
    state = binary_state(source, paths)
    plan = {
        "new": f"would install as {paths.binary}",
        "unchanged": f"same as {paths.binary}, would keep it",
        "update": f"would replace {paths.binary} and keep the old one as {paths.previous}",
    }[state]
    done = {
        "new": "new",
        "unchanged": "unchanged",
        "update": f"updated, old one kept as {paths.previous.name}",
    }[state]

    if dry_run:
        print("Dry run. Nothing is written and systemctl is not called.")
        print()
        print(f"Binary {source}, version {version}: {plan}.")
        print(f"Socket directory {settings.socket_dir}, mode 0750.")
        print()
        print(f"# {paths.env_file} (mode 0600, directory 0700)")
        print(render_env(settings.values, masked=True))
        print(f"# {paths.unit}")
        print(unit)
        print("Then: systemctl --user daemon-reload")
        print(f"      systemctl --user enable {SERVICE}")
        return

    private_dir(paths.config_dir, 0o700)
    private_dir(settings.socket_dir, 0o750)
    if settings.dictation:
        private_dir(settings.socket_dir / "stt", 0o750)
    paths.unit_dir.mkdir(parents=True, exist_ok=True)
    install_binary(source, paths, state)
    env_changed = write_atomic(paths.env_file, render_env(settings.values, masked=False), 0o600)
    unit_changed = write_atomic(paths.unit, unit, 0o644)
    systemctl("daemon-reload")
    systemctl("enable", SERVICE)

    changed = [name for name, flag in (
        ("binary", state != "unchanged"), ("settings", env_changed), ("unit", unit_changed),
    ) if flag]
    active = systemctl("is-active", "--quiet", SERVICE, check=False, quiet=True).returncode == 0
    print()
    print(f"Installed tmuxde {version} as a systemd user service. {'Running' if active else 'Not started'}.")
    print(f"  Binary    {paths.binary} ({done})")
    print(f"  Settings  {paths.env_file} (mode 0600, {'changed' if env_changed else 'unchanged'})")
    print(f"  Unit      {paths.unit} (enabled, {'changed' if unit_changed else 'unchanged'})")
    print(f"  Socket    {settings.values['TMUXDE_LISTEN']}")
    print(f"  tmux      {settings.values.get('TMUX_SOCKET', 'default server')}")
    print(f"  Dictation {'on, ' + settings.values['STT_SOCKET'] if settings.dictation else 'off'}")
    print(f"  PATH      {path}")
    print()
    if active and changed:
        print(f"tmuxde is running with the old {', '.join(changed)}. Apply with:")
        print(f"  systemctl --user restart {SERVICE}")
    elif active:
        print("tmuxde is running. Nothing changed.")
    else:
        print("Next steps. Browsers reach it once Caddy proxies to the socket.")
        print(f"  systemctl --user start {SERVICE}")
        print(f"  systemctl --user status {SERVICE}")
        print("  journalctl --user -u tmuxde -f")
    print()
    print_linger_note()


def uninstall_host_service(purge, dry_run):
    paths = host_paths(Path.home())
    removed = [paths.unit]
    if purge:
        removed += [paths.env_file, paths.binary, paths.previous]
    removed = [path for path in removed if path.exists()]
    kept = [] if purge else [path for path in (paths.env_file, paths.binary, paths.previous) if path.exists()]
    if paths.dropins.exists():
        kept.append(paths.dropins)

    if dry_run:
        print("Dry run. Nothing is removed and systemctl is not called.")
        print(f"Would run: systemctl --user disable --now {SERVICE}")
        for path in removed:
            print(f"Would remove {path}")
        for path in kept:
            print(f"Would keep {path}")
        return

    if not shutil.which("systemctl"):
        raise SystemExit("systemctl is not on PATH.")
    if systemctl("disable", "--now", SERVICE, check=False).returncode != 0:
        print(f"{SERVICE} was not enabled or not loaded. Continuing.")
    for path in removed:
        path.unlink()
        print(f"Removed {path}")
    systemctl("daemon-reload")
    systemctl("reset-failed", SERVICE, check=False, quiet=True)
    if purge and paths.config_dir.is_dir():
        leftover = sorted(item.name for item in paths.config_dir.iterdir())
        if leftover:
            kept.append(paths.config_dir)
            print(f"Kept {paths.config_dir} with {', '.join(leftover)}.")
        else:
            paths.config_dir.rmdir()
            print(f"Removed {paths.config_dir}")
    for path in kept:
        if path != paths.config_dir:
            print(f"Kept {path}")
    if not purge and kept:
        print("Rerun with --purge to remove the settings and binaries too.")
    print(f"{SERVICE} is stopped, disabled and removed.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--dictation", dest="dictation", action="store_true", default=None,
                       help="Enable speech to text. Downloads a 670 MB model once.")
    group.add_argument("--no-dictation", dest="dictation", action="store_false",
                       help="Disable speech to text. Keeps the downloaded model.")
    host = parser.add_argument_group("host service")
    host.add_argument("--host-service", action="store_true",
                      help="Install .docker/bin/tmuxde as a systemd user service and enable it."
                           " Does not start it and does not touch the Docker stack.")
    host.add_argument("--uninstall", action="store_true",
                      help="With --host-service: stop, disable and remove the unit."
                           " Keeps settings and binary.")
    host.add_argument("--purge", action="store_true",
                      help="With --uninstall: also remove settings and binaries.")
    host.add_argument("--print", dest="dry_run", action="store_true",
                      help="With --host-service: show what would be written. Token masked.")
    args = parser.parse_args()

    if args.host_service:
        if args.dictation is not None:
            parser.error("--dictation and --no-dictation do not apply to --host-service")
        if args.purge and not args.uninstall:
            parser.error("--purge needs --uninstall")
        if args.uninstall:
            uninstall_host_service(args.purge, args.dry_run)
        else:
            install_host_service(Path(__file__).resolve().parents[2], args.dry_run)
        return
    if args.uninstall or args.purge or args.dry_run:
        parser.error("--uninstall, --purge and --print need --host-service")

    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise SystemExit("Local Docker setup requires Linux x86_64.")

    local = Path(__file__).resolve().parents[2] / ".docker"
    token_path = local / ".env.token"
    if token_path.exists():
        token = token_path.read_text().strip()
        if not re.fullmatch(r"[0-9a-f]{64}", token):
            raise SystemExit("Invalid token in .docker/.env.token.")
    else:
        token = secrets.token_hex(32)
        token_path.touch(mode=0o600)
        token_path.write_text(token + "\n")
    token_path.chmod(0o600)

    upload_dir = (Path.home() / ".local" / "share" / "tmuxde" / "uploads").resolve()
    upload_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    upload_dir.chmod(0o700)

    values = {
        "AUTH_TOKEN": token,
        "LOCAL_UID": str(os.getuid()),
        "LOCAL_GID": str(os.getgid()),
        "DEV_UID": str(os.getuid()),
        "DEV_GID": str(os.getgid()),
        "LOCAL_UPLOAD_DIR": str(upload_dir),
        "LOCAL_HOST_HOME": str(Path.home().resolve()),
    }
    env_path = local.parent / ".env"
    # Keys of older setups (STT_URL, LOCAL_TMUX_DIR, LOCAL_TMUX_SOCKET) are
    # read here and not written back.
    previous = read_env(env_path)
    values.update(network_settings(previous))
    socket_dir = stt_socket_dir(previous)
    values[SOCKET_DIR_KEY] = str(socket_dir)
    dictation = args.dictation
    if dictation is None:
        dictation = "dictation" in previous.get("COMPOSE_PROFILES", "").split(",")
    values.update(dictation_settings(dictation))
    env_path.touch(mode=0o600)
    env_path.chmod(0o600)
    with env_path.open("w") as env:
        for key, value in values.items():
            if "\n" in value or "\r" in value:
                raise SystemExit(f"{key} must fit on one line.")
            value = value.replace("'", "\\'")
            env.write(f"{key}='{value}'\n")
    print("Token: .docker/.env.token")
    print(f"Run directory: {socket_dir}")
    print(f"Dictation: {'on' if dictation else 'off'}")
    print("Setup complete. Run docker compose up -d --build.")


if __name__ == "__main__":
    main()
