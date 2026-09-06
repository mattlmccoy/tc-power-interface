"""Auto-shutoff TIMER: after a set number of minutes (1-99, per the AG Plasma manual's TIMER menu)
command RF **off**. This is a safety convenience — it only ever disables RF; it never enables it,
so it can never be a route to turning power on.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

#: Hard bounds for the timer (1-99 minutes per the AG Plasma manual).
TIMER_BOUNDS: dict[str, tuple[int, int]] = {"minutes": (1, 99)}


@dataclass(frozen=True)
class TimerPlan:
    minutes: int = 10

    @classmethod
    def bounded(cls, *, minutes: float) -> TimerPlan:
        lo, hi = TIMER_BOUNDS["minutes"]
        return cls(minutes=int(max(lo, min(minutes, hi))))


class TimerController:
    """Count elapsed time while running; at ``minutes`` command ``controller.disable_rf()`` once."""

    def __init__(self, controller: Any, *, plan: TimerPlan) -> None:
        self.controller = controller
        self.plan = plan
        self.running = False
        self.done = False
        self.elapsed_s = 0.0

    def _limit_s(self) -> float:
        return float(self.plan.minutes) * 60.0

    def start(self) -> None:
        self.running = True
        self.done = False
        self.elapsed_s = 0.0

    def stop(self) -> None:
        self.running = False

    def tick(self, dt_s: float) -> None:
        if not self.running or self.done:
            return
        self.elapsed_s += dt_s
        if self.elapsed_s >= self._limit_s():
            self.controller.disable_rf()
            self.done = True
            self.running = False

    def snapshot(self) -> dict[str, Any]:
        remaining = max(0.0, self._limit_s() - self.elapsed_s)
        return {
            "running": self.running,
            "done": self.done,
            "minutes": self.plan.minutes,
            "elapsed_s": round(self.elapsed_s, 1),
            "remaining_s": round(remaining, 1),
        }
