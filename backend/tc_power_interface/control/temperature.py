"""Control-ROI temperature sources for the thermal loop.

``SimulatedThermalSource`` is a first-order power->temperature DEMONSTRATION model (NOT a validated
model of the real RF-heating system); it lets the closed loop converge in the simulator so the
control law and phase machine can be exercised. The FLIR-backed source lives in
``integration/flir_temperature.py`` and satisfies the same protocol.
"""

from __future__ import annotations

import time
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
