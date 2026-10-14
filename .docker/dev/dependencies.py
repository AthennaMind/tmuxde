#!/usr/bin/env python3
"""Synchronize container dependencies without exposing repository secrets."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
os.chdir(ROOT)
os.environ['DEV_UID'] = str(os.getuid())
os.environ['DEV_GID'] = str(os.getgid())
COMPOSE = ['docker', 'compose', '-f', '.docker/compose/tooling.yaml']
STACK = ['docker', 'compose']
# The Node app lives in src/ui. The installer sees these files under
# /manifests by name only, so an exported file maps back by its name.
APP = Path('src/ui')
MANIFESTS = [APP / 'package.json', APP / 'pnpm-lock.yaml', APP / 'pnpm-workspace.yaml']
VOLUME = 'tmuxde-dev-dependencies-v2'


def run(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def fingerprint():
    digest = hashlib.sha256()
    for path in MANIFESTS + [Path('.docker/dev/Dockerfile'), Path('.docker/dev/deps-manager.sh'), Path('.docker/dev/init-volumes.sh'), Path('.docker/compose/workspace.yaml')]:
        digest.update(str(path).encode() + b'\0' + path.read_bytes())
    digest.update(subprocess.check_output(['docker', 'image', 'inspect', 'tmuxde-dev:local', '--format', '{{json .RootFS.Layers}}']))
    return digest.hexdigest()


def marker(command):
    return ['docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
            '--security-opt', 'no-new-privileges', '--user', f'{os.getuid()}:{os.getgid()}',
            '--mount', f'type=volume,source={VOLUME},target=/deps',
            'tmuxde-dev:local', 'sh', '-c', command]


def sync(mutation=None, install_args=()):
    run(COMPOSE + ['build', '--quiet', 'deps-manager'], stdout=sys.stderr)
    wanted = fingerprint()
    exists = subprocess.run(['docker', 'volume', 'inspect', VOLUME], capture_output=True).returncode == 0
    if not exists:
        run(['docker', 'volume', 'create', '--label', 'com.docker.compose.project=tmuxde-tooling', '--label', 'com.docker.compose.volume=dependencies', VOLUME])
    old = subprocess.run(marker('head -c 65 /deps/root/.tmuxde-sync'), capture_output=True, text=True) if exists else None
    if mutation is None and not install_args and old is not None and old.returncode == 0 and old.stdout.strip() == wanted:
        print('Dependencies unchanged. Install skipped.')
        return
    running = subprocess.check_output(['docker', 'ps', '--filter', 'label=com.docker.compose.project=tmuxde', '--filter', 'label=dev.tmuxde.mode=development', '--format', '{{.Label "com.docker.compose.service"}}'], text=True).split()
    # Services that mount the dependency volume. server-dev does not, and
    # stopping it would end its tmux sessions for nothing.
    resume = [s for s in ('ui',) if s in running]
    if resume:
        run(STACK + ['stop', *resume])
    run(COMPOSE + ['run', '--rm', '-T', 'volume-init'])
    # Clear success marker before any dependency writes. Failed installs cannot be reused.
    run(marker('rm -f /deps/root/.tmuxde-sync'))
    if install_args:
        mutation = ['install', *install_args]
    if mutation:
        with tempfile.TemporaryDirectory(prefix='tmuxde-manifests-') as export:
            run(COMPOSE + ['run', '--rm', '-T', '-v', f'{export}:/export', 'deps-manager', 'mutate', *mutation])
            staging = Path(export)
            policy = staging / 'pnpm-workspace.yaml'
            if policy.is_symlink() or policy.read_bytes() != (ROOT / APP / 'pnpm-workspace.yaml').read_bytes():
                raise RuntimeError('Dependency command changed security policy. Review pnpm-workspace.yaml explicitly.')
            # Only known manifests may return to host. Never copy package code or executable files.
            for manifest in MANIFESTS:
                source = staging / manifest.name
                if source.is_symlink() or not source.is_file():
                    raise RuntimeError(f'Invalid exported manifest: {manifest.name}')
                if manifest.suffix == '.json':
                    json.loads(source.read_text())
            for manifest in MANIFESTS:
                if manifest.name != 'pnpm-workspace.yaml':
                    shutil.copyfile(staging / manifest.name, ROOT / manifest)
    else:
        run(COMPOSE + ['run', '--rm', '-T', 'deps-manager', 'download', *install_args])
    run(COMPOSE + ['run', '--rm', '-T', 'deps-build', 'build'])
    wanted = fingerprint()
    run(marker(f"printf '%s\\n' '{wanted}' > /deps/root/.tmuxde-sync"))
    if resume:
        run(STACK + ['up', '-d', '--no-build', '--wait', '--wait-timeout', '180', *resume])


if __name__ == '__main__':
    # Serialize installs across shells and hooks. Lock lives outside repository.
    with open(f'/tmp/tmuxde-deps-{os.getuid()}.lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            args = sys.argv[1:]
            sync(mutation=args[1:] if args and args[0] == 'mutate' else None,
                 install_args=args[1:] if args and args[0] == 'install' else ())
        except (subprocess.CalledProcessError, RuntimeError) as error:
            print(f'Dependency synchronization failed: {error}', file=sys.stderr)
            sys.exit(1)
