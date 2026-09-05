"""Persist the editable safety limits to a git-ignored ``.safety_limits.json`` sidecar.

Mirrors the FLIR rf-link settings pattern. Loading always clamps into the hard bounds, so a
hand-edited or stale file can never widen protection past a hard cap.
"""

from __future__ import annotations

import json
from pathlib import Path

from tc_power_interface.control.safety import SafetyLimits

CONFIG_NAME = ".safety_limits.json"


def load_limits(root: Path) -> SafetyLimits:
    path = Path(root) / CONFIG_NAME
    try:
        d = json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return SafetyLimits()
    return SafetyLimits.bounded(
        max_forward_w=d.get("max_forward_w", 350),
        max_reflected_w=d.get("max_reflected_w", 25.0),
        temperature_c_trip=d.get("temperature_c_trip", 70.0),
    )


def save_limits(root: Path, limits: SafetyLimits) -> None:
    Path(root).mkdir(parents=True, exist_ok=True)
    (Path(root) / CONFIG_NAME).write_text(
        json.dumps(
            {
                "max_forward_w": limits.max_forward_w,
                "max_reflected_w": limits.max_reflected_w,
                "temperature_c_trip": limits.temperature_c_trip,
            },
            indent=2,
        )
    )
