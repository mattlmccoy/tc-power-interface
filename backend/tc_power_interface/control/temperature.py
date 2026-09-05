"""Control-ROI temperature sources for the thermal loop.

``SimulatedThermalSource`` is a first-order power->temperature DEMONSTRATION model (NOT a validated
model of the real RF-heating system); it lets the closed loop converge in the simulator so the
control law and phase machine can be exercised. The FLIR-backed source lives in
``integration/flir_temperature.py`` and satisfies the same protocol.
"""

from __future__ import annotations

import bisect
import time
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Protocol


@dataclass(frozen=True)
class TemperatureSample:
    celsius: float
    valid: bool
    ts: float


class TemperatureSource(Protocol):
    def read(self) -> TemperatureSample: ...


class SimulatedThermalSource:
    """dT/dt = k_heat * P_load - k_cool * (T - ambient), integrated by explicit Euler."""

    def __init__(self, *, ambient_c: float = 25.0, k_heat: float = 0.125,
                 k_cool: float = 0.1) -> None:
        self.ambient_c = ambient_c
        self.k_heat = k_heat
        self.k_cool = k_cool
        self._t = ambient_c

    def step(self, load_w: float, dt_s: float) -> None:
        self._t += (self.k_heat * load_w - self.k_cool * (self._t - self.ambient_c)) * dt_s

    def read(self) -> TemperatureSample:
        return TemperatureSample(celsius=self._t, valid=True, ts=time.time())


class RecordedTemperatureSource:
    """Replays a recorded ``(time_s, celsius)`` trace (e.g. a FLIR control-ROI series).

    A cursor advances in simulated time via :meth:`advance`; :meth:`read` returns the linearly
    interpolated temperature at the cursor, holding the last value past the end. It has no ``step``
    method so the thermal loop treats it as an external source (it does not integrate a model).
    """

    def __init__(self, times_s: Sequence[float], celsius: Sequence[float]) -> None:
        if len(times_s) == 0 or len(times_s) != len(celsius):
            raise ValueError("times_s and celsius must be non-empty and the same length")
        self._times = [float(t) for t in times_s]
        self._temps = [float(c) for c in celsius]
        self._cursor = self._times[0]

    def advance(self, dt_s: float) -> None:
        self._cursor += dt_s

    def read(self) -> TemperatureSample:
        return TemperatureSample(celsius=self._interp(self._cursor), valid=True, ts=self._cursor)

    def _interp(self, t: float) -> float:
        times = self._times
        if t <= times[0]:
            return self._temps[0]
        if t >= times[-1]:
            return self._temps[-1]
        i = bisect.bisect_right(times, t)  # times[i-1] <= t < times[i]
        t0, t1 = times[i - 1], times[i]
        c0, c1 = self._temps[i - 1], self._temps[i]
        if t1 == t0:
            return c1
        return c0 + (c1 - c0) * (t - t0) / (t1 - t0)
