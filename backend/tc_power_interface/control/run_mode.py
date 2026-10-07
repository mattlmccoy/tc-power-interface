"""Run mode for the cockpit: what the operator is doing (ladder / fixed / to-temperature).

Display and bookkeeping ONLY. It never sets power (D1). The to-temperature target lives in the
thermal plan (``PUT /api/thermal/plan``), not here, so there is one source of truth for the target.

Persisted to a git-ignored ``.run_mode.json`` sidecar; loading is tolerant of any garbage.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

MODES = ("ladder", "fixed", "target")
FILE_NAME = ".run_mode.json"
LOAD_CEILING_W = 10_000  # a stale file is re-clamped by the caller's real limit when it is used


@dataclass(frozen=True)
class RunMode:
    mode: str = "ladder"
    ladder_w: tuple[int, ...] = ()  # no default steps: the network still changes between runs
    fixed_w: int = 0
    fixed_min: float = 0.0


def _finite(x: object) -> float | None:
    """The value as a finite float, or None for bools, non-numbers, NaN and inf."""
    if isinstance(x, bool) or not isinstance(x, (int, float)):
        return None
    return float(x) if math.isfinite(x) else None


def _clamp_w(x: object, max_forward_w: int) -> int:
    v = _finite(x)
    return 0 if v is None else int(max(0, min(v, max_forward_w)))


def parse_run_mode(body: dict[str, Any], *, max_forward_w: int) -> RunMode:
    mode = body.get("mode")
    if mode == "angle":
        raise ValueError("angle schedule is not available yet (turntable not built)")
    if mode not in MODES:
        raise ValueError(f"unknown run mode: {mode!r}")
    raw = body.get("ladder_w")
    raw_steps = raw if isinstance(raw, list) else []
    steps = sorted({_clamp_w(w, max_forward_w) for w in raw_steps if (_finite(w) or 0.0) > 0.0})
    fixed_min = _finite(body.get("fixed_min"))
    return RunMode(
        mode=mode,
        ladder_w=tuple(steps),
        fixed_w=_clamp_w(body.get("fixed_w"), max_forward_w),
        fixed_min=max(0.0, fixed_min) if fixed_min is not None else 0.0,
    )


def load_run_mode(root: Path, *, max_forward_w: int = LOAD_CEILING_W) -> RunMode:
    try:
        d = json.loads((Path(root) / FILE_NAME).read_text())
        if not isinstance(d, dict):
            return RunMode()
        return parse_run_mode(d, max_forward_w=max_forward_w)
    except (OSError, ValueError, TypeError):
        return RunMode()


def save_run_mode(root: Path, m: RunMode) -> None:
    Path(root).mkdir(parents=True, exist_ok=True)
    payload = {
        "mode": m.mode,
        "ladder_w": list(m.ladder_w),
        "fixed_w": m.fixed_w,
        "fixed_min": m.fixed_min,
    }
    (Path(root) / FILE_NAME).write_text(json.dumps(payload, indent=2))
