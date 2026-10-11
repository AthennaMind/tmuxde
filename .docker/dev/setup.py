#!/usr/bin/env python3
"""Prepare host tmux client and private credentials for local Docker stack."""

import argparse
import hashlib
import os
import platform
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tempfile
import urllib.request


def output(*args):
    return subprocess.check_output(args, text=True).strip()


NETWORK_KEYS = ("LOCAL_DOMAIN", "LOCAL_BIND_IP")

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
    """Compose profile and relay address for the optional speech service."""
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
        "STT_URL": "ws://stt:24400",
        "LOCAL_STT_MODELS": str(root),
        "STT_THREADS": str(threads),
    }


def workspace_mountpoints(root):
    """Empty dirs where dependency volumes mount over the read-only source bind."""
    for manifest in [*root.glob("apps/*/package.json"), *root.glob("packages/*/package.json")]:
        (manifest.parent / "node_modules").mkdir(exist_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--dictation", dest="dictation", action="store_true", default=None,
                       help="Enable speech to text. Downloads a 670 MB model once.")
    group.add_argument("--no-dictation", dest="dictation", action="store_false",
                       help="Disable speech to text. Keeps the downloaded model.")
    args = parser.parse_args()

    if platform.system() != "Linux" or platform.machine() != "x86_64":
        raise SystemExit("Local Docker setup requires Linux x86_64 with glibc.")

    tmux = shutil.which("tmux")
    if not tmux:
        raise SystemExit("Install tmux and start a session before setup.")

    socket = Path(os.environ.get("TMUX_SOCKET") or output(
        tmux, "display-message", "-p", "#{socket_path}"
    )).resolve()
    if not socket.is_socket() or socket.stat().st_uid != os.getuid():
        raise SystemExit("TMUX_SOCKET must name an existing socket owned by current user.")

    libraries = {}
    for line in output("ldd", tmux).splitlines():
        match = re.search(r"(?:=>\s+)?(/\S+)\s+\(", line)
        if match:
            source = Path(match.group(1))
            libraries[source.name] = source.resolve()
    loader = "ld-linux-x86-64.so.2"
    if loader not in libraries:
        raise SystemExit("Host tmux must use glibc dynamic loader.")

    local = Path(__file__).resolve().parents[2] / ".docker"
    host_tmux = local / "host-tmux"
    host_tmux.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=host_tmux) as staging:
        for name, source in {"tmux": tmux, **libraries}.items():
            staged = Path(staging) / name
            shutil.copy2(source, staged)
            staged.replace(host_tmux / name)

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
        "LOCAL_TMUX_DIR": str(socket.parent),
        "LOCAL_TMUX_SOCKET": socket.name,
        "LOCAL_UPLOAD_DIR": str(upload_dir),
        "LOCAL_HOST_HOME": str(Path.home().resolve()),
    }
    env_path = local.parent / ".env"
    previous = read_env(env_path)
    values.update(network_settings(previous))
    dictation = args.dictation
    if dictation is None:
        dictation = "dictation" in previous.get("COMPOSE_PROFILES", "").split(",")
    values.update(dictation_settings(dictation))
    workspace_mountpoints(local.parent)
    env_path.touch(mode=0o600)
    env_path.chmod(0o600)
    with env_path.open("w") as env:
        for key, value in values.items():
            if "\n" in value or "\r" in value:
                raise SystemExit(f"{key} must fit on one line.")
            value = value.replace("'", "\\'")
            env.write(f"{key}='{value}'\n")
    print(f"Prepared {output(tmux, '-V')} for socket {socket}")
    print("Token: .docker/.env.token")
    print(f"Dictation: {'on' if dictation else 'off'}")


if __name__ == "__main__":
    main()
