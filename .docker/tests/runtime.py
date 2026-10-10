#!/usr/bin/env python3
"""Check resolved development relay paths before starting containers."""
import json
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
config = json.loads(subprocess.check_output([
    'docker', 'compose', 'config', '--format', 'json',
], cwd=root))
relay = config['services']['relay']
assert relay['user'] == config['services']['deps-manager']['user'], 'Installer and relay must use same host IDs'
assert config['services']['volume-init']['environment']['DEV_UID'] == relay['user'].split(':')[0], 'Volume ownership must match relay user'
home = relay['environment']['HOME']
assert any(mount['type'] == 'bind' and mount['target'] == home
           and Path(mount['source']).is_dir()
           for mount in relay['volumes']), 'Relay HOME must point to mounted host home'
print('Relay HOME points to mounted host home')
