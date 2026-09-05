"""Device-layer base types: the telemetry snapshot and the serial-transport interface.

A :class:`Transport` is a thin byte pipe (write / read-exactly-N / close). All CXN framing
lives in :mod:`tc_power_interface.protocol.codec` and the high-level device wrapper, so the
same logic runs over a simulated transport and a real serial port. Concrete transports
(simulated, serial) self-register via :func:`register_transport`.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass

from tc_power_interface.protocol.codec import Status


@dataclass(frozen=True)
class Telemetry:
    """One immutable telemetry sample from the generator."""

    host_timestamp_ns: int
    forward_w: float
    reverse_w: float
    load_w: float
    reflected_fraction: float
    status: Status
    rf_on: bool
    temperature_c: float
    operation_mode: str
    tuner: str
    # Matching-network / generator readback (from the CXN GT block); defaults keep older
    # constructors and hand-built test samples valid.
    manual_mode: bool = False
    tune_cap_percent: float = 0.0
    load_cap_percent: float = 0.0
    dc_voltage: float = 0.0
    preset_slot: int = 0


class Transport(ABC):
    """A byte pipe to the generator (real serial port or an in-process simulator)."""

    name: str = "transport"

    @abstractmethod
    def write(self, data: bytes) -> None:
        """Write raw bytes to the device."""

    @abstractmethod
    def read(self, n: int) -> bytes:
        """Read exactly ``n`` bytes, blocking until available.

        :raises TimeoutError: if ``n`` bytes are not available in time.
        """

    @abstractmethod
    def close(self) -> None:
        """Release the underlying resource."""
