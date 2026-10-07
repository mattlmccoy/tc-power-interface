"""Shadow loop: the power a PI loop WOULD set to reach the target, from the live plant estimate.

SIMC tuning from (K, τ): τc = max(τ/2, 30 s), θ = DEAD_TIME_S, Kc = τ / (K(τc + θ)),
Ti = min(τ, 4(τc + θ)). The integral starts at the operator's current power (bumpless) and is
clamped to [0, ceiling]; the suggestion is clamped to [0, ceiling] and moves at most MAX_STEP_W per
step, starting from your power. Call :meth:`step` once per estimator grid sample (5 s). Pure: it is
handed numbers and returns numbers. Spec §3.3.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from tc_power_interface.control.plant_estimator import GRID_S, PlantEstimate

DEAD_TIME_S = 10.0  # provisional; Task 4 measures it on real runs
MIN_TC_S = 30.0
MAX_STEP_W = 10.0
SETTLE_BAND_C = 1.0


def pi_gains(k: float, tau: float) -> tuple[float, float]:
    """SIMC PI gains (Kc in W/°C, Ti in s) for a first-order plant with gain k and time tau."""
    tc = max(tau / 2.0, MIN_TC_S)
    return tau / (k * (tc + DEAD_TIME_S)), min(tau, 4.0 * (tc + DEAD_TIME_S))


def plateau_c(t_amb: float, k: float, power_w: float) -> float:
    """Temperature the part levels off at if held at power_w."""
    return t_amb + k * power_w


def time_to_target_s(plateau: float, target: float, temp: float, tau: float) -> float | None:
    """Seconds until temp reaches target on the way to plateau; None if it never will."""
    if not (plateau > target > temp):
        return None
    return -tau * math.log((plateau - target) / (plateau - temp))


def settle_time_s(plateau: float, temp: float, tau: float) -> float:
    """Seconds until temp is within SETTLE_BAND_C of plateau."""
    gap = abs(plateau - temp)
    return 0.0 if gap <= SETTLE_BAND_C else tau * math.log(gap / SETTLE_BAND_C)


@dataclass(frozen=True)
class ShadowOutput:
    suggest_w: float | None


class ShadowLoop:
    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self._integral: float | None = None
        self._prev: float | None = None

    def step(
        self,
        est: PlantEstimate,
        *,
        temp_c: float | None,
        power_w: float,
        target_c: float,
        ceiling_w: float,
    ) -> ShadowOutput:
        """One grid-sample update; suggest_w is None without a valid estimate or temperature."""
        if not est.valid or temp_c is None:
            return ShadowOutput(None)
        assert est.k_c_per_w is not None and est.tau_s is not None
        kc, ti = pi_gains(est.k_c_per_w, est.tau_s)
        err = target_c - temp_c
        if self._integral is None:
            # bumpless: integral AND rate limiter start from the operator's power
            self._integral = float(power_w)
            self._prev = float(power_w)
        self._integral = min(ceiling_w, max(0.0, self._integral + kc * err * GRID_S / ti))
        u = min(ceiling_w, max(0.0, kc * err + self._integral))
        if self._prev is not None:
            u = min(self._prev + MAX_STEP_W, max(self._prev - MAX_STEP_W, u))
        self._prev = u
        return ShadowOutput(u)
