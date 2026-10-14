#!/usr/bin/env python3
"""Tests for the host service parts of setup.py. Run: python3 -B .docker/dev/setup_test.py

Nothing here touches systemd, tmux or the real home. Every file lives in a
temp directory.
"""

import importlib.util
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location("tmuxde_setup", Path(__file__).with_name("setup.py"))
setup = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(setup)

TOKEN = "ab" * 32


def executable(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n")
    path.chmod(0o755)


class ServicePathTest(unittest.TestCase):
    def test_tool_dirs_first_then_full_system_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            brew = Path(tmp) / "brew" / "bin"
            executable(brew / "tmux")
            executable(brew / "git")
            with mock.patch.dict(os.environ, {"PATH": str(brew)}):
                path = setup.service_path().split(":")
        self.assertEqual(path, [str(brew), *setup.SYSTEM_PATH])

    def test_system_path_matches_ubuntu_environment(self):
        # /etc/environment and systemctl --user show-environment on Ubuntu.
        want = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/usr/games:/usr/local/games:/snap/bin"
        self.assertEqual(":".join(setup.SYSTEM_PATH), want)
        for directory in setup.SYSTEM_PATH:
            self.assertRegex(directory, setup.UNIT_PATH_DIR)

    def test_no_duplicates_when_tools_live_in_system_dirs(self):
        with mock.patch.object(setup.shutil, "which", lambda tool: f"/usr/bin/{tool}"):
            path = setup.service_path().split(":")
        self.assertEqual(path, ["/usr/bin", *[d for d in setup.SYSTEM_PATH if d != "/usr/bin"]])


class TmuxSocketSettingTest(unittest.TestCase):
    def test_unset_or_default_socket_stays_unset(self):
        self.assertIsNone(setup.tmux_socket_setting({}, 1000))
        self.assertIsNone(setup.tmux_socket_setting({"TMUX_SOCKET": ""}, 1000))
        self.assertIsNone(setup.tmux_socket_setting({"TMUX_SOCKET": "/tmp/tmux-1000/default"}, 1000))

    def test_other_socket_is_written(self):
        cases = {
            "/tmp/tmux-1000/work": "/tmp/tmux-1000/work",
            "/run/user/1000/tmux-1000/default": "/run/user/1000/tmux-1000/default",
            "/tmp/tmux-1001/default": "/tmp/tmux-1001/default",
        }
        for value, want in cases.items():
            self.assertEqual(setup.tmux_socket_setting({"TMUX_SOCKET": value}, 1000), want)

    def test_bad_values_stop(self):
        for value in ("tmp/tmux-1000/default", "/tmp/tmux-1000/.."):
            with self.assertRaises(SystemExit):
                setup.tmux_socket_setting({"TMUX_SOCKET": value}, 1000)


class HostSettingsTest(unittest.TestCase):
    def settings(self, environ, extra=""):
        with tempfile.TemporaryDirectory() as tmp:
            root, home = Path(tmp) / "repo", Path(tmp) / "home"
            (root / ".docker").mkdir(parents=True)
            home.mkdir()
            (root / ".docker" / ".env.token").write_text(TOKEN + "\n")
            (root / ".env").write_text(
                f"LOCAL_HOST_HOME='{home}'\n"
                f"LOCAL_UPLOAD_DIR='{home}/up'\n"
                f"LOCAL_STT_SOCKET_DIR='{home}/run'\n"
                + extra
            )
            with mock.patch.dict(os.environ, environ, clear=False):
                if "TMUX_SOCKET" not in environ:
                    os.environ.pop("TMUX_SOCKET", None)
                settings = setup.host_settings(root, home)
            return settings.values, setup.render_env(settings.values, masked=True), home

    def test_default_socket_leaves_tmux_socket_unset(self):
        values, text, _ = self.settings({"TMUX_SOCKET": f"/tmp/tmux-{os.getuid()}/default"})
        self.assertNotIn("TMUX_SOCKET", values)
        self.assertIn("# TMUX_SOCKET is unset.", text)
        self.assertNotIn("\nTMUX_SOCKET=", text)

    def test_other_socket_is_written(self):
        values, text, _ = self.settings({"TMUX_SOCKET": f"/tmp/tmux-{os.getuid()}/work"})
        self.assertEqual(values["TMUX_SOCKET"], f"/tmp/tmux-{os.getuid()}/work")
        self.assertIn(f"\nTMUX_SOCKET=/tmp/tmux-{os.getuid()}/work\n", text)
        self.assertNotIn("# TMUX_SOCKET is unset.", text)
        self.assertNotIn(TOKEN, text)

    def test_stale_keys_are_ignored(self):
        # Keys from the Node relay setup, still in an old root .env.
        stale = (
            "STT_URL='ws://stt:24400'\n"
            "LOCAL_TMUX_DIR='/tmp/tmux-1000'\n"
            "LOCAL_TMUX_SOCKET='work'\n"
        )
        values, text, _ = self.settings({}, stale)
        self.assertNotIn("TMUX_SOCKET", values)
        self.assertNotIn("STT_URL", text)
        self.assertNotIn("24400", text)

    def test_stt_socket_in_its_own_subdir(self):
        values, text, home = self.settings({}, "COMPOSE_PROFILES='dictation'\n")
        self.assertEqual(values["STT_SOCKET"], f"{home}/run/stt/stt.sock")
        self.assertEqual(values["TMUXDE_LISTEN"], f"unix:{home}/run/http.sock")
        self.assertIn(f"\nSTT_SOCKET={home}/run/stt/stt.sock\n", text)

    def test_dictation_off_leaves_stt_socket_unset(self):
        values, _, _ = self.settings({})
        self.assertNotIn("STT_SOCKET", values)


class SocketDirTest(unittest.TestCase):
    def test_creates_dev_and_stt_subdirs(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / "run"
            with mock.patch.dict(os.environ, {setup.SOCKET_DIR_KEY: str(run)}):
                directory = setup.stt_socket_dir({})
            self.assertEqual(directory, run.resolve())
            for path in (run, run / "dev", run / "stt"):
                self.assertTrue(path.is_dir())
                self.assertEqual(path.stat().st_mode & 0o777, 0o750)

    def test_long_path_stops(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = Path(tmp) / ("x" * 100)
            with mock.patch.dict(os.environ, {setup.SOCKET_DIR_KEY: str(run)}):
                with self.assertRaises(SystemExit):
                    setup.stt_socket_dir({})
            self.assertFalse(run.exists())


if __name__ == "__main__":
    unittest.main()
