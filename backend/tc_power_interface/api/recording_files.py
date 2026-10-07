"""/api/recordings/{run}/files* and /reveal — list/download a run's files, open its folder.

Whitelisted names only, resolved and confined to experiments_root/<run>. Read-only w.r.t. the
generator; reveal only launches the OS file browser (argv list, never a shell)."""

from __future__ import annotations

import re
import subprocess
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any, cast

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse

__all__ = ["reveal_argv", "router", "system_launcher"]

router = APIRouter(prefix="/api/recordings")

ALLOWED_FILES = (
    "telemetry.csv", "scope.csv", "scope_levels.csv", "scope_session.json",
    "events.json", "manifest.json", "metadata.json",
)
_WAVEFORM_RE = re.compile(r"^scope_waveforms/[0-9.]+W\.csv$")
_WAVEFORM_DIR = "scope_waveforms"


def reveal_argv(run_dir: Path, platform: str) -> list[str]:
    """Command that opens the OS file browser at run_dir."""
    if platform == "darwin":
        return ["open", "-R", str(run_dir)]
    if platform.startswith("win"):
        return ["explorer", "/select,", str(run_dir)]
    return ["xdg-open", str(run_dir)]


def system_launcher(argv: list[str]) -> None:
    subprocess.Popen(argv)  # noqa: S603 - fixed argv list from reveal_argv, no shell


def _is_allowed(rel: str) -> bool:
    return rel in ALLOWED_FILES or bool(_WAVEFORM_RE.match(rel))


def _run_dir(request: Request, run: str) -> Path:
    if not run or run in (".", "..") or "/" in run or "\\" in run or ".." in run:
        raise HTTPException(400, "invalid run name")
    root = Path(request.app.state.recorder.experiments_root).resolve()
    target = (root / run).resolve()
    if target.parent != root:
        raise HTTPException(400, "invalid run name")
    if not target.is_dir():
        raise HTTPException(404, "no such recording")
    return target


@router.get("/{run}/files")
def list_files(request: Request, run: str) -> dict[str, Any]:
    d = _run_dir(request, run)
    names = [n for n in ALLOWED_FILES if (d / n).is_file()]
    wf = d / _WAVEFORM_DIR
    if wf.is_dir():
        names += sorted(
            f"{_WAVEFORM_DIR}/{p.name}" for p in wf.iterdir()
            if p.is_file() and _is_allowed(f"{_WAVEFORM_DIR}/{p.name}")
        )
    return {"files": names}


@router.get("/{run}/files/{path:path}")
def download_file(request: Request, run: str, path: str) -> FileResponse:
    d = _run_dir(request, run)
    if not _is_allowed(path):
        raise HTTPException(400, "file not downloadable")
    f = (d / path).resolve()
    if d not in f.parents:  # belt and braces: symlink or odd path escaping the run dir
        raise HTTPException(400, "invalid path")
    if not f.is_file():
        raise HTTPException(404, "no such file")
    return FileResponse(f, filename=f"{run}_{f.name}")


@router.post("/{run}/reveal")
def reveal(request: Request, run: str) -> dict[str, Any]:
    d = _run_dir(request, run)
    launcher = cast(
        Callable[[list[str]], None], getattr(request.app.state, "reveal_launcher", system_launcher)
    )
    try:
        launcher(reveal_argv(d, sys.platform))
    except OSError as exc:
        raise HTTPException(500, f"could not open file browser: {exc}") from exc
    return {"ok": True, "path": str(d)}
