"""Persisted scope settings (experiments_root/scope_settings.json). No calibration constants
live here: only the loop geometry the flux formula needs and the warn-only limits."""

from __future__ import annotations

import json
import logging
import math
import os
from dataclasses import asdict, dataclass, field, fields, replace
from pathlib import Path
from typing import Any

from tc_power_interface.analysis.flux import LoopGeometry, ScopeLimits

logger = logging.getLogger(__name__)
FILENAME = "scope_settings.json"


@dataclass(frozen=True)
class ScopeSettings:
    resource: str = ""
    channel: int = 1
    probe_attn: float = 50.0  # must match the PHA0150 range switch; checked against ATTN?
    core_label: str = "core 2"
    geometry: LoopGeometry = field(default_factory=LoopGeometry)
    limits: ScopeLimits = field(default_factory=ScopeLimits)
    tol_w: float = 1.0
    settle_s: float = 3.0
    poll_interval_s: float = 0.2


_CHANNELS = (1, 2)
MIN_POLL_INTERVAL_S = 0.05  # faster polling only burns USB bandwidth; the scope cannot keep up


def _num(name: str, v: Any, kind: type[int] | type[float]) -> Any:
    """Coerce a number or numeric string (UI inputs send strings); bools and junk are errors."""
    if isinstance(v, bool) or not isinstance(v, (int, float, str)):
        raise ValueError(f"{name} must be a number, got {v!r}")
    try:
        x = float(v)
    except ValueError:
        raise ValueError(f"{name} must be a number, got {v!r}") from None
    if not math.isfinite(x):
        raise ValueError(f"{name} must be finite, got {v!r}")
    if kind is int:
        if not x.is_integer():
            raise ValueError(f"{name} must be an integer, got {v!r}")
        return int(x)
    return x


def _section(name: str, v: Any) -> dict[str, Any]:
    if not isinstance(v, dict):
        raise ValueError(f"{name} must be an object, got {v!r}")
    return v


def _check_keys(name: str, d: dict[str, Any], allowed: set[str]) -> None:
    unknown = sorted(set(d) - allowed)
    if unknown:
        raise ValueError(f"unknown {name} key(s): {', '.join(unknown)}")


def settings_from_dict(d: dict[str, Any]) -> ScopeSettings:
    """Build validated settings from a (possibly partial) dict. Numeric strings are coerced;
    unknown keys, wrong types and out-of-range values raise ValueError."""
    base = ScopeSettings()
    _check_keys("settings", d, {f.name for f in fields(ScopeSettings)})
    g = {**asdict(base.geometry), **_section("geometry", d.get("geometry", {}))}
    _check_keys("geometry", g, {f.name for f in fields(LoopGeometry)})
    lm = {**asdict(base.limits), **_section("limits", d.get("limits", {}))}
    _check_keys("limits", lm, {f.name for f in fields(ScopeLimits)})
    geo = LoopGeometry(
        turns=_num("geometry.turns", g["turns"], int),
        cores_linked=_num("geometry.cores_linked", g["cores_linked"], int),
        ae_per_core_m2=_num("geometry.ae_per_core_m2", g["ae_per_core_m2"], float),
    )
    lim = ScopeLimits(**{k: _num(f"limits.{k}", v, float) for k, v in lm.items()})
    flat: dict[str, Any] = {}
    for k in ("resource", "core_label"):
        if k in d:
            if not isinstance(d[k], str):
                raise ValueError(f"{k} must be a string, got {d[k]!r}")
            flat[k] = d[k]
    if "channel" in d:
        flat["channel"] = _num("channel", d["channel"], int)
        if flat["channel"] not in _CHANNELS:
            raise ValueError(f"channel must be one of {_CHANNELS}, got {d['channel']!r}")
    for k in ("probe_attn", "tol_w", "settle_s", "poll_interval_s"):
        if k in d:
            flat[k] = _num(k, d[k], float)
    out = replace(base, geometry=geo, limits=lim, **flat)
    if out.probe_attn <= 0 or out.tol_w <= 0 or out.settle_s < 0:
        raise ValueError("need probe_attn > 0, tol_w > 0, settle_s >= 0")
    if out.poll_interval_s < MIN_POLL_INTERVAL_S:
        raise ValueError(f"poll_interval_s must be >= {MIN_POLL_INTERVAL_S}")
    return out


def load_settings(root: Path) -> ScopeSettings:
    p = Path(root) / FILENAME
    if not p.exists():
        return ScopeSettings()
    try:
        return settings_from_dict(json.loads(p.read_text()))
    except (OSError, ValueError, TypeError) as exc:
        logger.warning("ignoring bad %s: %s", p, exc)
        return ScopeSettings()


def save_settings(root: Path, s: ScopeSettings) -> None:
    """Atomic write (temp file + os.replace): a crash never leaves a half-written file."""
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    tmp = root / f".{FILENAME}.tmp"
    try:
        tmp.write_text(json.dumps(asdict(s), indent=2))
        os.replace(tmp, root / FILENAME)
    finally:
        tmp.unlink(missing_ok=True)
