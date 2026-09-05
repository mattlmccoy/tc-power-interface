"""A control-ROI temperature source backed by the FLIR Research Interface thermal stream.

Satisfies the same ``read() -> TemperatureSample`` protocol as the toy sim model, so the thermal
loop can use either interchangeably. It holds the latest ROI temperature, updated by applying FLIR
``/ws/frames`` messages: :meth:`apply_frame` is pure and unit-tested; :meth:`run` is a thin live
consumer that requires a running FLIR backend.

Safety: before any frame arrives (or after a stream drop with no fresh frame) the reading is
``valid=False`` so the thermal loop can refuse to drive on stale/absent temperature rather than
treating an absent reading as 0 C and ramping up.
"""

from __future__ import annotations

import time

from tc_power_interface.control.temperature import TemperatureSample
from tc_power_interface.integration.flir_client import (
    control_temperature,
    stream_control_temperature,
)


class FlirTemperatureSource:
    """Latest FLIR ROI temperature, updated from ``/ws/frames`` messages."""

    def __init__(self, url: str, *, stat: str = "center_c") -> None:
        self.url = url
        self.stat = stat
        self._latest = TemperatureSample(celsius=0.0, valid=False, ts=0.0)

    def apply_frame(self, message: bytes) -> None:
        """Update the latest reading from one FLIR frame; ignore malformed frames (keep last)."""
        try:
            celsius = control_temperature(message, stat=self.stat)
        except (ValueError, KeyError):
            return
        self._latest = TemperatureSample(celsius=celsius, valid=True, ts=time.time())

    def read(self) -> TemperatureSample:
        return self._latest

    async def run(self) -> None:  # pragma: no cover - requires a live FLIR backend
        """Consume the live FLIR stream, updating the latest reading until cancelled."""
        async for celsius in stream_control_temperature(self.url, stat=self.stat):
            self._latest = TemperatureSample(celsius=celsius, valid=True, ts=time.time())
