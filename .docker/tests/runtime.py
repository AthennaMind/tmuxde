#!/usr/bin/env python3
"""Check resolved development users and container isolation before starting containers."""
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
config = json.loads(subprocess.check_output([
    'docker', 'compose', 'config', '--format', 'json',
], cwd=root))
services = config['services']
ui = services['ui']
assert ui['user'] == services['deps-manager']['user'], 'Installer and ui must use same host IDs'
assert services['volume-init']['environment']['DEV_UID'] == ui['user'].split(':')[0], 'Volume ownership must match ui user'
print('ui and dependency installer use same host IDs')

dev = services['server-dev']
env = dev['environment']
assert env['HOME'].startswith('/tmp/'), 'server-dev HOME must stay in its tmpfs'
assert env['TMUX_SOCKET'].startswith('/tmp/'), 'server-dev must run its own tmux server'
assert dev.get('network_mode') == 'none', 'server-dev must have no network'
# Every bind is this checkout, a part of it, or a subdir of the run dir.
# Never host home, the host tmux socket or the run dir itself, which holds
# the production http.sock.
runs = {}
for mount in dev['volumes']:
    if mount['type'] != 'bind':
        continue
    source, target = mount['source'], mount['target']
    if target.startswith('/run/tmuxde'):
        runs[target] = mount
        continue
    in_checkout = source == str(root) or source.startswith(str(root) + '/')
    assert in_checkout, f'server-dev mounts {source} at {target}'
assert sorted(runs) == ['/run/tmuxde/dev', '/run/tmuxde/stt'], f'server-dev run dir mounts: {sorted(runs)}'
assert not runs['/run/tmuxde/dev'].get('read_only'), 'server-dev needs dev read write for http-dev.sock'
assert runs['/run/tmuxde/stt'].get('read_only'), 'server-dev must mount stt read only'
assert env['STT_SOCKET'] == '/run/tmuxde/stt/stt.sock', 'server-dev must dial stt in its subdir'
print('server-dev uses its own tmux and HOME, without network, host home or the production socket')

stt = services.get('stt')
if stt is not None:
    assert stt.get('network_mode') == 'none', 'stt must have no network'
    targets = sorted(m['target'] for m in stt['volumes'] if m['type'] == 'bind' and m['target'].startswith('/run/tmuxde'))
    assert targets == ['/run/tmuxde/stt'], f'stt run dir mounts: {targets}'
    assert stt.get('read_only') is True, 'stt must have a read only root'
    assert stt.get('cap_drop') == ['ALL'], 'stt must drop every capability'
    assert 'no-new-privileges:true' in stt.get('security_opt', []), 'stt must set no-new-privileges'
    assert not stt.get('ports'), 'stt must publish no port'
    print('stt has no network, no port, a read only root and writes only its socket subdir')
