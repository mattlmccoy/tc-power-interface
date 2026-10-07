"""Persist the thermal plan to a git-ignored ``.thermal_plan.json`` sidecar.

Loading always clamps through ``ThermalPlan.bounded`` (with the current ``max_forward_w``), so a
stale file can never set a loop ceiling above the forward-power limit or the hard caps.
"""

from __future__ import annotations

import json
from pathlib import Path

from tc_power_interface.control.thermal_loop import ThermalPlan

CONFIG_NAME = ".thermal_plan.json"


def load_plan(root: Path, *, max_forward_w: int) -> ThermalPlan:
    path = Path(root) / CONFIG_NAME
    try:
        d = json.loads(path.read_text())
    except (FileNotFoundError, ValueError):
        return ThermalPlan()
    return ThermalPlan.bounded(
        target_c=d.get("target_c", 185.0),
        soak_s=d.get("soak_s", 30.0),
        approach_band_c=d.get("approach_band_c", 15.0),
        loop_ceiling_w=d.get("loop_ceiling_w", 200),
        max_step_w=d.get("max_step_w", 25),
        done_below_c=d.get("done_below_c", 50.0),
        max_forward_w=max_forward_w,
    )


def save_plan(root: Path, plan: ThermalPlan) -> None:
    Path(root).mkdir(parents=True, exist_ok=True)
    (Path(root) / CONFIG_NAME).write_text(
        json.dumps(
            {
                "target_c": plan.target_c,
                "soak_s": plan.soak_s,
                "approach_band_c": plan.approach_band_c,
                "loop_ceiling_w": plan.loop_ceiling_w,
                "max_step_w": plan.max_step_w,
                "done_below_c": plan.done_below_c,
            },
            indent=2,
        )
    )


SOURCE_NAME = ".thermal_source.json"


def load_source(root: Path, *, default_type: str) -> dict[str, str | None]:
    """The operator's temperature-source choice: ``{"type": "flir"|"simulated", "roi": name|None}``.

    No ROI name is ever invented: FLIR ROIs are redrawn between prints (``circle_medium_small``
    existed
    on 09-08 and not after), so until the operator picks one the ROI is None and the loop says so.
    """
    try:
        d = json.loads((Path(root) / SOURCE_NAME).read_text())
    except (FileNotFoundError, ValueError):
        return {"type": default_type, "roi": None}
    kind = d.get("type") if d.get("type") in ("flir", "simulated") else default_type
    roi = d.get("roi")
    return {"type": kind, "roi": roi if isinstance(roi, str) and roi else None}


def save_source(root: Path, source: dict[str, str | None]) -> None:
    Path(root).mkdir(parents=True, exist_ok=True)
    (Path(root) / SOURCE_NAME).write_text(
        json.dumps({"type": source.get("type"), "roi": source.get("roi")})
    )
