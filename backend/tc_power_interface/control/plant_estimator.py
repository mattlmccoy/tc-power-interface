"""Live estimate of the part's first-order heating response: dT/dt = a·P − b·(T − T_amb).

K = a/b (°C per W) and τ = 1/b (s), by recursive least squares on a fixed 5 s grid (the first
tick at or after each grid time is taken). Derivative = central difference of a centred 30 s
moving average, so each update lags the newest sample by 20 s. T_amb = the temperature at the
first RF-on grid sample. Pure: no I/O and no actuators. Spec §3.2 of the cockpit design.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

GRID_S = 5.0
HALF_WINDOW = 3  # 7 grid points = a 30 s centred moving average
LAG = 4  # smoothing (3) + central difference (1)
FORGET = 0.995
RESID_ALPHA = 0.05
MIN_UPDATES = 6
COV_INIT = 100.0
MIN_POWER_W = 1.0


@dataclass(frozen=True)
class PlantEstimate:
    k_c_per_w: float | None
    tau_s: float | None
    confidence: float
    t_amb_c: float | None
    updates: int

    @property
    def valid(self) -> bool:
        return self.k_c_per_w is not None


class PlantEstimator:
    """Feed every telemetry tick to :meth:`add`; it keeps one sample per 5 s grid step."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self._t_next: float | None = None
        self._p: list[float] = []
        self._t: list[float | None] = []
        self._theta = [0.0, 0.0]
        self._cov = [[COV_INIT, 0.0], [0.0, COV_INIT]]
        self._r2 = 0.0
        self._n = 0
        self._t_amb: float | None = None
        self.grid_samples = 0

    def add(
        self, t_s: float, power_w: float, temp_c: float | None, *, rf_on: bool
    ) -> PlantEstimate:
        if self._t_next is not None and t_s < self._t_next:
            return self.estimate()
        self._t_next = t_s + GRID_S if self._t_next is None else self._t_next + GRID_S
        while self._t_next <= t_s:
            self._t_next += GRID_S
        p = float(power_w) if rf_on else 0.0
        self._p.append(p)
        self._t.append(temp_c)
        self.grid_samples += 1
        if self._t_amb is None and p >= MIN_POWER_W and temp_c is not None:
            self._t_amb = float(temp_c)
        self._update(len(self._t) - 1)
        return self.estimate()

    def _smoothed(self, k: int) -> float | None:
        window = self._t[max(0, k - HALF_WINDOW) : k + HALF_WINDOW + 1]
        vals = [v for v in window if v is not None]
        return sum(vals) / len(vals) if len(vals) == len(window) else None

    def _update(self, i: int) -> None:
        j = i - LAG
        if self._t_amb is None or j < 1 or self._p[j] < MIN_POWER_W:
            return
        lo, mid, hi = self._smoothed(j - 1), self._smoothed(j), self._smoothed(j + 1)
        if lo is None or mid is None or hi is None:
            return
        y = (hi - lo) / (2 * GRID_S)
        phi = (self._p[j], -(mid - self._t_amb))
        c = self._cov
        pp = (c[0][0] * phi[0] + c[0][1] * phi[1], c[1][0] * phi[0] + c[1][1] * phi[1])
        den = FORGET + phi[0] * pp[0] + phi[1] * pp[1]
        gain = (pp[0] / den, pp[1] / den)
        err = y - (phi[0] * self._theta[0] + phi[1] * self._theta[1])
        self._theta = [self._theta[0] + gain[0] * err, self._theta[1] + gain[1] * err]
        self._cov = [
            [(c[0][0] - gain[0] * pp[0]) / FORGET, (c[0][1] - gain[0] * pp[1]) / FORGET],
            [(c[1][0] - gain[1] * pp[0]) / FORGET, (c[1][1] - gain[1] * pp[1]) / FORGET],
        ]
        self._r2 = (
            err * err if self._n == 0 else (1 - RESID_ALPHA) * self._r2 + RESID_ALPHA * err * err
        )
        self._n += 1

    def estimate(self) -> PlantEstimate:
        a, b = self._theta
        if self._n < MIN_UPDATES or a <= 0 or b <= 0:
            return PlantEstimate(None, None, 0.0, self._t_amb, self._n)
        se_a = math.sqrt(max(self._cov[0][0], 0.0) * self._r2)
        se_b = math.sqrt(max(self._cov[1][1], 0.0) * self._r2)
        conf = min(1.0, max(0.0, 1.0 - (se_a / a + se_b / b)))
        if conf <= 0.0:  # zero confidence = the fit is noise (e.g. steady power): still learning
            return PlantEstimate(None, None, 0.0, self._t_amb, self._n)
        return PlantEstimate(a / b, 1.0 / b, conf, self._t_amb, self._n)
