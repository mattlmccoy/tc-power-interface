"""Persisted scope settings (experiments_root/scope_settings.json). No calibration constants
live here: only the loop geometry the flux formula needs and the warn-only limits."""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field, replace
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


def settings_from_dict(d: dict[str, Any]) -> ScopeSettings:
    base = ScopeSettings()
    geo = LoopGeometry(**{**asdict(base.geometry), **d.get("geometry", {})})
    lim = ScopeLimits(**{**asdict(base.limits), **d.get("limits", {})})
    flat = {k: v for k, v in d.items() if k not in ("geometry", "limits") and hasattr(base, k)}
    return replace(base, geometry=geo, limits=lim, **flat)


def load_settings(root: Path) -> ScopeSettings:
    p = Path(root) / FILENAME
    if not p.exists():
        return ScopeSettings()
    try:
        return settings_from_dict(json.loads(p.read_text()))
    except (ValueError, TypeError) as exc:
        logger.warning("ignoring bad %s: %s", p, exc)
        return ScopeSettings()


def save_settings(root: Path, s: ScopeSettings) -> None:
    Path(root).mkdir(parents=True, exist_ok=True)
    (Path(root) / FILENAME).write_text(json.dumps(asdict(s), indent=2))
