"""Shared helpers for the agent skill's script tests (`skills/draft-canvas/scripts/`).

The scripts are installed into agents' skill folders and run there, on repositories nobody here has
seen, so the tests build small repositories on disk and run the scripts as an agent would.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import ModuleType

# Importing the scripts here must not leave a __pycache__ in the skill folder, which ships as is.
sys.dont_write_bytecode = True

SCRIPTS = Path(__file__).resolve().parents[2] / 'skills' / 'draft-canvas' / 'scripts'
REFERENCES = SCRIPTS.parent / 'references'


def load(name: str) -> ModuleType:
    """Imports one of the skill's scripts as a module."""
    if str(SCRIPTS) not in sys.path:
        sys.path.insert(0, str(SCRIPTS))
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / f'{name}.py')
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_tree(root: Path, files: dict[str, str | bytes]) -> Path:
    for rel, content in files.items():
        path = root / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        if isinstance(content, bytes):
            path.write_bytes(content)
        else:
            path.write_text(content, encoding='utf-8')
    return root


def git_init(root: Path) -> None:
    env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_SYSTEM': os.devnull}
    # No background maintenance: a commit of a few thousand files can start a detached `git maintenance` that is
    # still writing inside `.git` when the test's folder is deleted ("Directory not empty: '.git'").
    quiet = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false']
    for args in (['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'x']):
        subprocess.run(['git', *quiet, '-C', str(root), *args], check=True, env=env, capture_output=True)


def run_script(name: str, *args: str, env: dict[str, str] | None = None, isolated: bool = True) -> subprocess.CompletedProcess[str]:
    """Runs a script the way the skill tells an agent to: `python3 <script> …` (isolated unless the
    test needs the environment to reach Python, as PYTHONIOENCODING does)."""
    flags = ['-I'] if isolated else []
    return subprocess.run(
        [sys.executable, *flags, str(SCRIPTS / f'{name}.py'), *args],
        capture_output=True,
        text=True,
        encoding='utf-8',
        env={**os.environ, **(env or {})},
        timeout=120,
        check=False,
    )


class TempRepo:
    """A throwaway folder; `with TempRepo(files, git=True) as root:`."""

    def __init__(self, files: dict[str, str | bytes], git: bool = False):
        self.files = files
        self.git = git
        self._dir: tempfile.TemporaryDirectory[str] | None = None

    def __enter__(self) -> Path:
        self._dir = tempfile.TemporaryDirectory()
        root = Path(self._dir.name) / 'repo'
        root.mkdir()
        write_tree(root, self.files)
        if self.git:
            git_init(root)
        return root

    def __exit__(self, *exc: object) -> None:
        assert self._dir
        # A process that was still finishing in the folder can make one removal fail; try again, then let go.
        for attempt in range(5):
            try:
                self._dir.cleanup()
                return
            except OSError:
                time.sleep(0.2 * (attempt + 1))
        shutil.rmtree(self._dir.name, ignore_errors=True)


def example_request() -> dict:
    return json.loads((REFERENCES / 'example-create.json').read_text(encoding='utf-8'))
