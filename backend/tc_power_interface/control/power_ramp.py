"""Software power ramping: ramp the RF forward-power setpoint from an initial value to a target at a
fixed W/s rate, mirroring the AG generator's native RAMP mode (INIT power, RATE 1-99 W/s).

Safety: this only adjusts the RF *setpoint* (clamped by the protection limits via
``controller.set_setpoint``). It NEVER enables RF — the operator does that; the ramp just moves the
commanded power once RF is on.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

#: Hard bounds for the ramp plan (rate 1-99 W/s per the AG Plasma manual; power clamped to forward).
RAMP_BOUNDS: dict[str, tuple[int, int]] = {
    "init_w": (0, 600),
    "target_w": (0, 600),
    "rate_w_per_s": (1, 99),
}


@dataclass(frozen=True)
class RampPlan:
    init_w: int = 0
    target_w: int = 100
    rate_w_per_s: int = 10

    @classmethod
    def bounded(
        cls, *, init_w: float, target_w: float, rate_w_per_s: float, max_forward_w: int
    ) -> RampPlan:
        def clamp(name: str, v: float, hi: int | None = None) -> int:
            lo, high = RAMP_BOUNDS[name]
            return int(max(lo, min(v, hi if hi is not None else high)))

        return cls(
            init_w=clamp("init_w", init_w, max_forward_w),
            target_w=clamp("target_w", target_w, max_forward_w),
            rate_w_per_s=clamp("rate_w_per_s", rate_w_per_s),
        )


def ramp_step(current_w: float, target_w: float, rate_w_per_s: float, dt_s: float) -> float:
    """Move ``current_w`` toward ``target_w`` by at most rate*dt, never overshooting."""
    step = rate_w_per_s * dt_s
    if current_w < target_w:
        return min(current_w + step, target_w)
    if current_w > target_w:
        return max(current_w - step, target_w)
    return target_w


class RampController:
    """Ramp ``controller.set_setpoint`` from ``init_w`` to ``target_w`` at ``rate_w_per_s``."""

    def __init__(self, controller: Any, *, plan: RampPlan) -> None:
        self.controller = controller
        self.plan = plan
        self.running = False
        self.done = False
        self.output_w = 0.0

    def _max_forward(self) -> int:
        limits = getattr(self.controller, "limits", None)
        return int(getattr(limits, "max_forward_w", 600))

    def start(self) -> None:
        self.running = True
        self.done = False
        self.output_w = min(float(self.plan.init_w), self._max_forward())
        self.controller.set_setpoint(int(round(self.output_w)))

    def stop(self) -> None:
        self.running = False

    def tick(self, dt_s: float) -> None:
        if not self.running or self.done:
            return
        target = min(self.plan.target_w, self._max_forward())
        self.output_w = ramp_step(self.output_w, target, self.plan.rate_w_per_s, dt_s)
        self.output_w = max(0.0, min(self.output_w, self._max_forward()))
        self.controller.set_setpoint(int(round(self.output_w)))
        if abs(self.output_w - target) < 1e-6:
            self.done = True

    def snapshot(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "done": self.done,
            "output_w": round(self.output_w, 1),
            "init_w": self.plan.init_w,
            "target_w": self.plan.target_w,
            "rate_w_per_s": self.plan.rate_w_per_s,
        }
