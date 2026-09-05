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


@dataclass(frozen=True)
class SafetyLimits:
    """Protection thresholds and command-side policy guards."""

    #: Hard RF-off trip on reflected fraction while RF is on.
    reflected_fraction_trip: float = 0.10
    #: Advisory warning threshold (surfaced to the UI, does not trip).
    reflected_fraction_warn: float = 0.02
    #: Optional absolute reflected-power trip in watts (percentage alone is insufficient
    #: as forward power rises). ``None`` disables the absolute check.
    reflected_w_trip: float | None = None
    #: Heat-sink temperature trip in deg C.
    temperature_c_trip: float = 70.0
    #: Trip if the newest telemetry sample is older than this (must stay < 2 s control lease).
    telemetry_timeout_s: float = 1.5
    #: Command-side policy ceiling on the forward-power setpoint (HT50 bank continuous policy).
    max_setpoint_w: int = 350

    def clamp_setpoint(self, watts: int) -> int:
        """Clamp a requested setpoint into ``[0, max_setpoint_w]``."""
        return max(0, min(int(watts), self.max_setpoint_w))


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
        if telemetry.reflected_fraction > limits.reflected_fraction_trip:
            reasons.append(
                f"reflected fraction {telemetry.reflected_fraction:.3f} > "
                f"{limits.reflected_fraction_trip:.3f}"
            )
        elif telemetry.reflected_fraction > limits.reflected_fraction_warn:
            warnings.append(
                f"reflected fraction {telemetry.reflected_fraction:.3f} above warn "
                f"{limits.reflected_fraction_warn:.3f}"
            )
        if limits.reflected_w_trip is not None and telemetry.reverse_w > limits.reflected_w_trip:
            reasons.append(
                f"reflected power {telemetry.reverse_w:.1f}W > {limits.reflected_w_trip:.1f}W"
            )

    return SafetyDecision(trip=bool(reasons), reasons=tuple(reasons), warnings=tuple(warnings))
