"""High-level CXN device wrapper over a :class:`Transport`.

Turns codec bytes into method calls: control lease, telemetry, identify, RF enable, setpoint,
and manual-tune readback/write. This one class is used with both the simulated transport and
(later) the real serial transport.

Safety: ``set_rf`` is the only path that enables RF and it is never called automatically here.
"""

from __future__ import annotations

import time

from tc_power_interface.device.base import Telemetry, Transport
from tc_power_interface.protocol import codec


class CxnDevice:
    """Command a CXN generator through a byte transport."""

    def __init__(self, transport: Transport, address: int = 0) -> None:
        self.transport = transport
        self.address = address

    # --- low-level framing -----------------------------------------------------------------
    def _read_ack(self) -> None:
        ack = self.transport.read(1)
        if ack == codec.ACK_OK:
            return
        if ack == codec.ACK_BAD:
            raise ValueError("device NACKed command ('?')")
        raise ValueError(f"unexpected acknowledgement byte {ack!r}")

    def _command(self, command: bytes) -> None:
        """Send a command that returns only an acknowledgement (no data response)."""
        self.transport.write(codec.encode_command(command, self.address))
        self._read_ack()

    def _query(self, command: bytes) -> bytes:
        """Send a command and return the data field of its response."""
        self.transport.write(codec.encode_command(command, self.address))
        self._read_ack()
        header = self.transport.read(4)
        datalength = int.from_bytes(header[2:4], "big")
        rest = self.transport.read(datalength + 2)
        return codec.decode_response(header + rest, self.address)

    # --- control lease ---------------------------------------------------------------------
    def request_control(self) -> bool:
        data = self._query(codec.cmd_request_control())
        return int.from_bytes(data[:2], "big") == 1

    def release_control(self) -> bool:
        data = self._query(codec.cmd_release_control())
        return int.from_bytes(data[:2], "big") == 0

    def ping(self) -> None:
        self._command(codec.cmd_ping())

    # --- telemetry -------------------------------------------------------------------------
    def read_telemetry(self) -> Telemetry:
        fwd, rev, load = codec.parse_power(self._query(codec.cmd_power()))
        gs = self._query(codec.cmd_status())
        status = codec.parse_status(gs)
        return Telemetry(
            host_timestamp_ns=time.time_ns(),
            forward_w=fwd,
            reverse_w=rev,
            load_w=load,
            reflected_fraction=(rev / fwd) if fwd > 0 else 0.0,
            status=status,
            rf_on=codec.Status.RF_ENABLED in status,
            temperature_c=codec.parse_temperature(gs),
            operation_mode=codec.parse_operation_mode(gs),
            tuner=codec.parse_tuner(gs),
        )

    def read_match(self) -> codec.GtBlock:
        return codec.parse_gt(self._query(codec.cmd_gt()))

    def identify(self) -> dict[str, object]:
        return {
            "id": codec.parse_id_string(self._query(codec.cmd_id())),
            "serial": codec.parse_id_string(self._query(codec.cmd_serial())),
            "firmware": codec.parse_firmware(self._query(codec.cmd_firmware())),
            "frequency_hz": codec.parse_frequency(self._query(codec.cmd_frequency())),
            "power_limit_w": codec.parse_power_limit(self._query(codec.cmd_power_limit())),
        }

    # --- writes ----------------------------------------------------------------------------
    def set_rf(self, on: bool) -> None:
        self._command(codec.cmd_rf_enable(on))

    def set_setpoint(self, watts: int) -> None:
        self._command(codec.cmd_setpoint(watts))

    def set_manual_mode(self, on: bool) -> None:
        self._command(codec.cmd_manual_mode(on))

    def set_tune_capacity(self, percent: int) -> None:
        self._command(codec.cmd_tune_capacity(percent))

    def set_load_capacity(self, percent: int) -> None:
        self._command(codec.cmd_load_capacity(percent))

    def close(self) -> None:
        self.transport.close()
