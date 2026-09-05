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
        target_c=d.get("target_c", 150.0),
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
