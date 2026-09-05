"""Real serial transport for a physical CXN generator (opt-in).

Thin wrapper over pyserial with the CXN's fixed line settings (38400 8N1). The higher layers
(codec, CxnDevice, Controller) are identical to the simulated path. This transport is only
selected explicitly (e.g. ``--serial /dev/tty...``); it is never the default.

NOTE (data-contract): reaching a real generator does not prove it speaks the CXN dialect. Use
``tcp-probe --serial <port>`` (read-only, RF off) and reconcile against the front panel before
any powered operation. See plan/notes.md.
"""

from __future__ import annotations

import serial

from tc_power_interface.device import register_transport
from tc_power_interface.device.base import Transport
from tc_power_interface.protocol.codec import SERIAL_SETTINGS


@register_transport("serial")
class SerialCxnTransport(Transport):
    """Byte pipe to a CXN over a serial/USB port."""

    name = "serial"

    def __init__(self, *, port: str, timeout: float = 1.0) -> None:
        self._port = port
        self._ser = serial.serial_for_url(
            port,
            baudrate=SERIAL_SETTINGS["baudrate"],
            bytesize=SERIAL_SETTINGS["bytesize"],
            parity=SERIAL_SETTINGS["parity"],
            stopbits=SERIAL_SETTINGS["stopbits"],
            timeout=timeout,
        )

    def write(self, data: bytes) -> None:
        self._ser.write(data)

    def read(self, n: int) -> bytes:
        buf = self._ser.read(n)
        if len(buf) < n:
            raise TimeoutError(
                f"serial read timed out on {self._port}: got {len(buf)} of {n} bytes"
            )
        return bytes(buf)

    def close(self) -> None:
        self._ser.close()
