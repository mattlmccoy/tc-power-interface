"""Simulator-first PULSE: gate the RF setpoint ON for TIME ON, then to 0 for TIME OFF, repeating
(1-9995 ms each, per the AG Plasma manual's PULSE menu; duty = on/(on+off)).

Safety/honesty: this only modulates the *setpoint* (via ``controller.set_setpoint``); it never
enables RF. The real generator has a hardware PULSE mode, but its serial command is unverified on
our unit, so this models the waveform in the simulator only.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

#: Hard bounds for the pulse plan (TIME ON / TIME OFF 1-9995 ms per the AG Plasma manual).
PULSE_BOUNDS: dict[str, tuple[int, int]] = {
    "on_ms": (1, 9995),
    "off_ms": (1, 9995),
}


def duty_cycle(on_ms: float, off_ms: float) -> float:
    """Fraction of the period spent ON = on/(on+off)."""
    total = on_ms + off_ms
    return 0.0 if total <= 0 else on_ms / total


def pulse_on(elapsed_s: float, on_ms: float, off_ms: float) -> bool:
    """True during the ON portion of the repeating period, given elapsed seconds."""
    period_s = (on_ms + off_ms) / 1000.0
    if period_s <= 0:
        return False
    phase_s = elapsed_s % period_s
    return phase_s < on_ms / 1000.0


@dataclass(frozen=True)
class PulsePlan:
    on_ms: int = 1000
    off_ms: int = 1000
    power_w: int = 100

    @classmethod
    def bounded(
        cls, *, on_ms: float, off_ms: float, power_w: float, max_forward_w: int
    ) -> PulsePlan:
        def clamp_ms(name: str, v: float) -> int:
            lo, hi = PULSE_BOUNDS[name]
            return int(max(lo, min(round(v), hi)))

        return cls(
            on_ms=clamp_ms("on_ms", on_ms),
            off_ms=clamp_ms("off_ms", off_ms),
            power_w=int(max(0, min(round(power_w), max_forward_w))),
        )


class PulseController:
    """Modulate ``controller.set_setpoint`` between ``power_w`` (ON) and 0 (OFF)."""

    def __init__(self, controller: Any, *, plan: PulsePlan) -> None:
        self.controller = controller
        self.plan = plan
        self.running = False
        self.elapsed_s = 0.0
        self.output_on = False

    def start(self) -> None:
        self.running = True
        self.elapsed_s = 0.0
        self.output_on = True

    def stop(self) -> None:
        self.running = False

    def tick(self, dt_s: float) -> None:
        if not self.running:
            return
        self.elapsed_s += dt_s
        self.output_on = pulse_on(self.elapsed_s, self.plan.on_ms, self.plan.off_ms)
        self.controller.set_setpoint(self.plan.power_w if self.output_on else 0)

    def snapshot(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "on_ms": self.plan.on_ms,
            "off_ms": self.plan.off_ms,
            "power_w": self.plan.power_w,
            "duty": round(duty_cycle(self.plan.on_ms, self.plan.off_ms), 3),
            "output_on": self.output_on,
        }
