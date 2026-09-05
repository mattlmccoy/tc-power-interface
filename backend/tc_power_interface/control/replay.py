"""Replay a recorded temperature trace through the real ThermalController control code.

This is a **counterfactual advisory overlay**, not a re-simulation: a recording is fixed history
(the temperatures already happened under whatever RF power was actually applied), so the loop cannot
change the outcome. What it CAN show is, at each recorded instant, what phase the loop would be in
and what RF setpoint it would command given that temperature. It exercises the exact production
control path (``ThermalController`` + ``plan_step`` + the PI law), driven by a
``RecordedTemperatureSource`` instead of the sim model.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from tc_power_interface.control.safety import SafetyLimits
from tc_power_interface.control.temperature import RecordedTemperatureSource
from tc_power_interface.control.thermal_loop import ThermalController, ThermalPlan


@dataclass(frozen=True)
class ReplayStep:
    t: float
    temp_c: float
    phase: str
    commanded_w: float


class _ReplayController:
    """Minimal stand-in for the live Controller: RF assumed on, forward power tracks commands.

    ``backend="simulated"`` so the loop's arming gate lets it drive in ``auto`` (the whole point of
    the replay is to see the command it produces); ``set_setpoint`` feeds the last command back as
    the current forward power so the PI rate-limiter behaves exactly as it would live.
    """

    def __init__(self, *, max_forward_w: int, rf_on: bool = True) -> None:
        self.backend = "simulated"
        self.limits = SafetyLimits(max_forward_w=max_forward_w)
        self._rf_on = rf_on
        self.forward_w = 0.0

    def set_setpoint(self, watts: int) -> int:
        self.forward_w = float(watts)
        return watts

    def snapshot(self) -> dict[str, Any]:
        return {
            "state": "connected",
            "telemetry": {
                "rf_on": self._rf_on,
                "forward_w": self.forward_w,
                "load_w": self.forward_w,
            },
        }


def replay_recorded(
    times_s: Sequence[float],
    celsius: Sequence[float],
    *,
    plan: ThermalPlan,
    max_forward_w: int,
    rf_on: bool = True,
) -> list[ReplayStep]:
    """Run the recorded ``(times_s, celsius)`` trace through the controller; one step per sample."""
    source = RecordedTemperatureSource(times_s, celsius)
    controller = _ReplayController(max_forward_w=max_forward_w, rf_on=rf_on)
    loop = ThermalController(controller, source, plan=plan, mode="auto")
    loop.start()

    steps: list[ReplayStep] = []
    prev_t = float(times_s[0])
    for t in times_s:
        dt = float(t) - prev_t
        prev_t = float(t)
        source.advance(dt)  # move the recorded cursor to this sample's time before the loop reads
        loop.tick(dt)
        steps.append(
            ReplayStep(
                t=float(t),
                temp_c=round(loop.control_temp_c, 2),
                phase=loop.phase.value,
                commanded_w=round(loop.recommended_w, 1),
            )
        )
    return steps
