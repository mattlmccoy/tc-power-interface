"""In-situ thermal closed loop: a pure ramp/approach/soak/cool control law and the controller that
applies it. Safety: the loop only adjusts the RF *setpoint* (bounded); it NEVER enables RF, and it
disarms on a fault or loss of RF. See the design spec under docs/superpowers/specs/.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass
from typing import Any

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
#: Integral gain (W per deg C-second) — eliminates the pure-proportional steady-state offset so the
#: loop actually reaches the target and can soak. Anti-windup clamps it to [0, ceiling].
KI_W_PER_C_S = 2.0


class ThermalPhase(enum.Enum):
    RAMP = "ramp"
    APPROACH = "approach"
    SOAK = "soak"
    COOL = "cool"
    DONE = "done"


#: Phases only advance (never regress), so a dip below target during soak does not reset the soak.
_PHASE_ORDER = {
    ThermalPhase.RAMP: 0,
    ThermalPhase.APPROACH: 1,
    ThermalPhase.SOAK: 2,
    ThermalPhase.COOL: 3,
    ThermalPhase.DONE: 4,
}


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


class ThermalController:
    """Runs ``plan_step`` against a temperature source + the main Controller.

    Drives ``controller.set_setpoint`` only when the arming gate allows; otherwise advisory. NEVER
    calls ``enable_rf``. A fault or loss of RF disarms.
    """

    def __init__(self, controller: Any, source: Any, *, plan: ThermalPlan,
                 mode: str = "advisory") -> None:
        self.controller = controller
        self.source = source
        self.plan = plan
        self.mode = mode
        self.running = False
        self.armed = False
        self.phase = ThermalPhase.RAMP
        self.control_temp_c = 0.0
        self.recommended_w = 0.0
        self.applied_w: float | None = None
        self.reason = ""
        self._soak_elapsed_s = 0.0
        self._integral = 0.0

    def _max_forward(self) -> int:
        limits = getattr(self.controller, "limits", None)
        return int(getattr(limits, "max_forward_w", 400))

    def start(self) -> None:
        self.running = True
        self.phase = ThermalPhase.RAMP
        self._soak_elapsed_s = 0.0
        self._integral = 0.0

    def stop(self) -> None:
        self.running = False
        self.armed = False

    def arm(self) -> None:
        self.armed = True

    def disarm(self) -> None:
        self.armed = False

    def _backend(self) -> str:
        return str(getattr(self.controller, "backend", "simulated"))

    def _may_drive(self, rf_on: bool, faulted: bool) -> bool:
        if self.mode != "auto" or faulted:
            return False
        if self._backend() == "simulated":
            return True
        return bool(rf_on and self.armed)

    def tick(self, dt_s: float) -> None:
        if not self.running:
            return
        snap = self.controller.snapshot()
        tel = snap.get("telemetry") or {}
        rf_on = bool(tel.get("rf_on"))
        faulted = snap.get("state") == "fault"
        if faulted or not rf_on:
            self.armed = False  # lose RF or fault -> disarm
        if hasattr(self.source, "step"):
            self.source.step(load_w=float(tel.get("load_w", 0.0)), dt_s=dt_s)
        self.control_temp_c = self.source.read().celsius

        current = float(tel.get("forward_w", 0.0))
        cmd = plan_step(temp_c=self.control_temp_c, phase=self.phase,
                        elapsed_soak_s=self._soak_elapsed_s, current_setpoint_w=current,
                        plan=self.plan)
        # Phases only advance (a dip below target during soak does not reset it).
        if _PHASE_ORDER[cmd.phase] >= _PHASE_ORDER[self.phase]:
            self.phase = cmd.phase
        if self.phase is ThermalPhase.SOAK:
            self._soak_elapsed_s += dt_s  # accumulate soak time in SIMULATED time
        self.reason = cmd.reason

        # PI power (integral removes the pure-proportional offset so the loop reaches target),
        # rate-limited by max_step and clamped to min(loop ceiling, max forward). 0 while cooling.
        ceiling = float(min(self.plan.loop_ceiling_w, self._max_forward()))
        if self.phase in (ThermalPhase.COOL, ThermalPhase.DONE):
            self._integral = 0.0
            power = 0.0
        else:
            error = self.plan.target_c - self.control_temp_c
            self._integral = max(0.0, min(self._integral + KI_W_PER_C_S * error * dt_s, ceiling))
            desired = max(0.0, min(KP_W_PER_C * error + self._integral, ceiling))
            power = max(current - self.plan.max_step_w,
                        min(desired, current + self.plan.max_step_w))
            power = max(0.0, min(power, ceiling))
        self.recommended_w = power

        if self._may_drive(rf_on, faulted):
            self.applied_w = self.controller.set_setpoint(int(power))
        else:
            self.applied_w = None

    def snapshot(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "phase": self.phase.value,
            "mode": self.mode,
            "armed": self.armed,
            "control_temp_c": round(self.control_temp_c, 1),
            "target_c": self.plan.target_c,
            "recommended_w": round(self.recommended_w, 1),
            "applied_w": self.applied_w,
        }
