"""Protection layer: a pure verdict from one telemetry sample.

This is the dominant control function (see the 2026-09-05 handoff). It never tunes or ramps;
it only decides whether RF must be commanded OFF. Keeping it pure makes the trip logic fully
testable and independent of threads, timing, and hardware.

Defaults are conservative starting values, NOT experimentally validated safe limits. The
reflected-fraction trip and the setpoint ceiling in particular should be revisited against
logged hot-load data and the HT50 bank policy (350 W continuous / 400 W brief) before real use.
"""

from __future__ import annotations

from dataclasses import dataclass

from tc_power_interface.device.base import Telemetry
from tc_power_interface.protocol.codec import Status

#: Hard outer bounds for the operator-editable limits: (min, max). Tighten-only — the operator
#: can never set a value outside these, so protection cannot be disabled or hardware over-driven.
HARD_BOUNDS: dict[str, tuple[float, float]] = {
    "max_forward_w": (0, 400),  # HT50 bank brief-test ceiling
    "max_reflected_w": (1.0, 200.0),
    "temperature_c_trip": (30.0, 90.0),
}


@dataclass(frozen=True)
class SafetyLimits:
    """Protection thresholds and command-side policy guards (editable ones are hard-bounded)."""

    #: Command-side ceiling on the forward-power setpoint (watts).
    max_forward_w: int = 350
    #: RF-off trip on absolute reflected power (watts) while RF is on.
    max_reflected_w: float = 25.0
    #: Heat-sink temperature trip (deg C).
    temperature_c_trip: float = 70.0
    #: Advisory-only reflected-fraction warn (drives the warnings banner, never trips).
    reflected_fraction_warn: float = 0.02
    #: Trip if the newest telemetry sample is older than this (must stay < 2 s control lease).
    telemetry_timeout_s: float = 1.5

    @classmethod
    def bounded(
        cls,
        *,
        max_forward_w: float,
        max_reflected_w: float,
        temperature_c_trip: float,
        reflected_fraction_warn: float = 0.02,
        telemetry_timeout_s: float = 1.5,
    ) -> SafetyLimits:
        """Build limits with each editable field clamped into its hard range."""

        def clamp(name: str, value: float) -> float:
            lo, hi = HARD_BOUNDS[name]
            return max(lo, min(value, hi))

        return cls(
            max_forward_w=int(clamp("max_forward_w", max_forward_w)),
            max_reflected_w=float(clamp("max_reflected_w", max_reflected_w)),
            temperature_c_trip=float(clamp("temperature_c_trip", temperature_c_trip)),
            reflected_fraction_warn=reflected_fraction_warn,
            telemetry_timeout_s=telemetry_timeout_s,
        )

    def clamp_setpoint(self, watts: int) -> int:
        """Clamp a requested setpoint into ``[0, max_forward_w]``."""
        return max(0, min(int(watts), self.max_forward_w))


@dataclass(frozen=True)
class SafetyDecision:
    """Verdict from :func:`evaluate`."""

    trip: bool
    reasons: tuple[str, ...]
    warnings: tuple[str, ...]


def evaluate(telemetry: Telemetry, limits: SafetyLimits, telemetry_age_s: float) -> SafetyDecision:
    """Decide whether the protection layer must command RF off for this sample."""
    reasons: list[str] = []
    warnings: list[str] = []

    if telemetry_age_s > limits.telemetry_timeout_s:
        reasons.append(
            f"telemetry stale/timeout ({telemetry_age_s:.2f}s > {limits.telemetry_timeout_s:.2f}s)"
        )

    if Status.OVER_TEMPERATURE in telemetry.status:
        reasons.append("generator reports OVER_TEMPERATURE")
    if Status.INTERLOCK_OPEN in telemetry.status:
        reasons.append("interlock open")
    if telemetry.temperature_c > limits.temperature_c_trip:
        reasons.append(
            f"heat-sink temperature {telemetry.temperature_c:.1f}C > "
            f"{limits.temperature_c_trip:.1f}C"
        )

    if telemetry.rf_on:
        if telemetry.reverse_w > limits.max_reflected_w:
            reasons.append(
                f"reflected power {telemetry.reverse_w:.1f}W > {limits.max_reflected_w:.1f}W"
            )
        elif telemetry.reflected_fraction > limits.reflected_fraction_warn:
            warnings.append(
                f"reflected fraction {telemetry.reflected_fraction:.3f} above warn "
                f"{limits.reflected_fraction_warn:.3f}"
            )

    return SafetyDecision(trip=bool(reasons), reasons=tuple(reasons), warnings=tuple(warnings))
