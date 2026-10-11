#!/usr/bin/env python3
"""Prepare host tmux client and private credentials for local Docker stack."""

import os
import platform
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tempfile


def output(*args):
    return subprocess.check_output(args, text=True).strip()


def main():
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
    env_path.touch(mode=0o600)
    env_path.chmod(0o600)
    with env_path.open("w") as env:
        for key, value in values.items():
            if "\n" in value or "\r" in value:
                raise SystemExit("Socket path must fit on one line.")
            value = value.replace("'", "\\'")
            env.write(f"{key}='{value}'\n")
    print(f"Prepared {output(tmux, '-V')} for socket {socket}")
    print("Token: .docker/.env.token")


if __name__ == "__main__":
    main()
