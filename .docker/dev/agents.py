#!/usr/bin/env python3
"""Provision two isolated demo agents for development server on port 18443."""
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / '.docker' / 'bin' / 'agents'
BINARY = '/tmp/tmuxde-dev/bin/tmuxde'


def compose(*args, capture=False):
    return subprocess.run(
        ['docker', 'compose', *args], cwd=ROOT, check=True,
        stdout=subprocess.PIPE if capture else None,
    ).stdout


def server(*args):
    return compose('exec', '-T', 'server-dev', BINARY, 'machine', *args, capture=True)


def main():
    os.umask(0o077)
    compose('run', '--rm', 'gotools', 'go', 'build', '-trimpath',
            '-o', '/out/tmuxde-agent-demo', './cmd/tmuxde')
    # Certificate is public. Private CA key never leaves Caddy volume.
    certificate = compose('exec', '-T', 'caddy', 'cat',
                          '/data/caddy/pki/authorities/local/root.crt', capture=True)
    records = {}
    for line in server('list').decode().splitlines():
        machine_id, status, name = line.split('\t', 2)
        records[name] = (machine_id, status)

    for short in ('alpha', 'beta'):
        label = f'Dev {short.title()}'
        state = OUTPUT / short / 'state'
        workspace = OUTPUT / short / 'workspace'
        state.mkdir(parents=True, exist_ok=True)
        workspace.mkdir(parents=True, exist_ok=True)
        token_file = state / 'agent-token'
        if label not in records:
            token = server('add', label)
            token_file.write_bytes(token)
        elif records[label][1] == 'revoked' or not token_file.exists():
            token = server('rotate', records[label][0])
            token_file.write_bytes(token)
        token_file.chmod(0o600)
        (state / 'root.crt').write_bytes(certificate)
        readme = workspace / 'README.md'
        if not readme.exists():
            readme.write_text(
                f'# {label}\n\n'
                f'This workspace belongs to dev-{short}.\n\n'
                'Both demo machines use session dev and path /workspace.\n'
                'Files and terminal processes stay separate.\n'
            )
        marker = workspace / 'machine.txt'
        if not marker.exists():
            marker.write_text(f'dev-{short}\n')

    compose('exec', '-T', 'caddy', 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile')
    compose('up', '-d', '--no-deps', '--force-recreate', 'agent-alpha', 'agent-beta')
    print('Dev Alpha and Dev Beta started. Open development UI on port 18443.')


if __name__ == '__main__':
    main()
