"""In-situ thermal closed loop: a pure ramp/approach/soak/cool control law and the controller that
applies it. Safety: the loop only adjusts the RF *setpoint* (bounded); it NEVER enables RF, and it
disarms on a fault or loss of RF. See the design spec under docs/superpowers/specs/.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass

#: Hard bounds for the thermal plan (tighten-only; loop_ceiling_w is also clamped to max_forward_w).
THERMAL_BOUNDS: dict[str, tuple[float, float]] = {
    "target_c": (30, 300),
    "soak_s": (0, 3600),
    "approach_band_c": (1, 60),
    "loop_ceiling_w": (0, 400),
    "max_step_w": (1, 50),
    "done_below_c": (25, 200),
}
#: Proportional gain (W per deg C of error) for the ramp/hold law.
KP_W_PER_C = 8.0


class ThermalPhase(enum.Enum):
    RAMP = "ramp"
    APPROACH = "approach"
    SOAK = "soak"
    COOL = "cool"
    DONE = "done"


@dataclass(frozen=True)
class ThermalPlan:
    target_c: float = 150.0
    soak_s: float = 30.0
    approach_band_c: float = 15.0
    loop_ceiling_w: int = 200
    max_step_w: int = 25
    done_below_c: float = 50.0

    @classmethod
    def bounded(cls, *, target_c: float, soak_s: float, approach_band_c: float,
                loop_ceiling_w: float, max_step_w: float, done_below_c: float,
                max_forward_w: int) -> ThermalPlan:
        def clamp(name: str, v: float) -> float:
            lo, hi = THERMAL_BOUNDS[name]
            return max(lo, min(v, hi))

        return cls(
            target_c=clamp("target_c", target_c),
            soak_s=clamp("soak_s", soak_s),
            approach_band_c=clamp("approach_band_c", approach_band_c),
            loop_ceiling_w=int(min(clamp("loop_ceiling_w", loop_ceiling_w), max_forward_w)),
            max_step_w=int(clamp("max_step_w", max_step_w)),
            done_below_c=clamp("done_below_c", done_below_c),
        )


@dataclass(frozen=True)
class ThermalCommand:
    phase: ThermalPhase
    target_power_w: float
    reason: str


def plan_step(*, temp_c: float, phase: ThermalPhase, elapsed_soak_s: float,
              current_setpoint_w: float, plan: ThermalPlan) -> ThermalCommand:
    """Pure control law: the new phase + a bounded target setpoint. The caller applies it."""
    if phase is ThermalPhase.DONE:
        return ThermalCommand(ThermalPhase.DONE, 0.0, "done")
    if phase is ThermalPhase.COOL:
        if temp_c < plan.done_below_c:
            return ThermalCommand(ThermalPhase.DONE, 0.0, "cooled below done threshold")
        return ThermalCommand(ThermalPhase.COOL, 0.0, "cooling")
    if phase is ThermalPhase.SOAK and elapsed_soak_s >= plan.soak_s:
        return ThermalCommand(ThermalPhase.COOL, 0.0, "soak complete -> cool")

    # Proportional desired power (clamped to the ceiling), then step-limited around the setpoint.
    desired = max(0.0, min(KP_W_PER_C * (plan.target_c - temp_c), float(plan.loop_ceiling_w)))
    target = max(current_setpoint_w - plan.max_step_w,
                 min(desired, current_setpoint_w + plan.max_step_w))
    target = max(0.0, min(target, float(plan.loop_ceiling_w)))

    if temp_c >= plan.target_c:
        return ThermalCommand(ThermalPhase.SOAK, target, "soaking near target")
    if temp_c >= plan.target_c - plan.approach_band_c:
        return ThermalCommand(ThermalPhase.APPROACH, target, "approaching target; easing off")
    return ThermalCommand(ThermalPhase.RAMP, target, "ramping to target")
