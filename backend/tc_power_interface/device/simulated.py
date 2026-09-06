"""In-process byte-level simulator of a CXN generator.

Implements the documented command/response behaviour so the whole stack (device wrapper,
controller, API, UI) can run and be tested with no hardware attached. It is a *model* of the
CXN, not a capture of the physical unit; before real-RF use, reconcile against a hardware
probe (see plan/notes.md, "Data-contract status").

Safety model: RF only turns on while control has been granted; releasing control forces RF off.
"""

from __future__ import annotations

import struct

from tc_power_interface.device import register_transport
from tc_power_interface.device.base import Transport
from tc_power_interface.protocol import codec


@register_transport("simulated")
class SimulatedCxnTransport(Transport):
    """A fake CXN that speaks the real wire protocol over an internal buffer."""

    name = "simulated"

    def __init__(
        self,
        *,
        address: int = 0,
        reflected_fraction: float = 0.01,
        temperature_c: float = 30.0,
    ) -> None:
        self.address = address
        self._reflected_fraction = reflected_fraction
        self._temperature_c = temperature_c
        # device state
        self.control_granted = False
        self.rf_on = False
        self.setpoint_w = 0
        self.manual_mode = False
        self.load_capacity = 0.0
        self.tune_capacity = 0.0
        self.interlock_open = False
        # identity
        self.id_string = "AG 0613"
        self.serial_number = "SIM-0001"
        self.firmware = (1, 2, 3, 4)  # ui_major, ui_minor, rf_major, rf_minor
        self.frequency_hz = 13_560_000
        self.power_limit_w = 600.0
        self.reverse_limit_w = 60.0
        # io buffer holding bytes queued for the host to read
        self._out = bytearray()

    # --- Transport interface ---------------------------------------------------------------
    def write(self, data: bytes) -> None:
        self._handle_frame(data)

    def read(self, n: int) -> bytes:
        if len(self._out) < n:
            raise TimeoutError(f"simulator has {len(self._out)} bytes queued, need {n}")
        chunk = bytes(self._out[:n])
        del self._out[:n]
        return chunk

    def close(self) -> None:
        self._out.clear()

    # --- internal helpers ------------------------------------------------------------------
    def _power_watts(self) -> tuple[float, float, float]:
        if not (self.control_granted and self.rf_on):
            return (0.0, 0.0, 0.0)
        fwd = float(self.setpoint_w)
        rev = fwd * self._reflected_fraction
        return (fwd, rev, fwd - rev)

    def _status_word(self) -> int:
        word = 0
        if self.rf_on:
            word |= codec.Status.RF_ENABLED
        if self.interlock_open:
            word |= codec.Status.INTERLOCK_OPEN
        return word

    def _ack(self, ok: bool) -> None:
        self._out += codec.ACK_OK if ok else codec.ACK_BAD

    def _respond(self, data: bytes) -> None:
        header = bytes([codec.HEADER_RESP, self.address]) + struct.pack(">H", len(data))
        self._out += header + data + codec.checksum(header + data)

    def _handle_frame(self, frame: bytes) -> None:
        # Validate the command frame the way the device would.
        if len(frame) != 10 or frame[0] != codec.HEADER_CMD:
            self._ack(False)
            return
        if codec.checksum(frame[:8]) != frame[8:10]:
            self._ack(False)
            return
        command = frame[2:8]
        mnem = command[:2]
        p1 = command[2:4]
        # dispatch
        if mnem == b"BC":  # request/release control (returns a 2-byte status)
            granted = p1 == b"\x55\x55"
            self.control_granted = granted
            if not granted:
                self.rf_on = False  # release forces safe defaults
            self._ack(True)
            self._respond(struct.pack(">H", 1 if granted else 0))
        elif mnem == b"BP":  # ping (ack only)
            self._ack(True)
        elif mnem == b"BR":  # RF enable/disable (ack only)
            if p1 == b"\x55\x55":
                self.rf_on = self.control_granted  # only on if we have control
            else:
                self.rf_on = False
            self._ack(True)
        elif mnem == b"SA":  # setpoint (ack only)
            self.setpoint_w = int.from_bytes(p1, "big")
            self._ack(True)
        elif mnem == b"TM":  # manual mode (ack only)
            self.manual_mode = p1 == b"\x00\x02"
            self._ack(True)
        elif mnem == b"TC":  # tune/load capacity (ack only); value is percent*10 (0.1% resolution)
            value = int.from_bytes(command[4:6], "big") / 10
            if p1 == b"\x00\x01":
                self.load_capacity = value
            elif p1 == b"\x00\x02":
                self.tune_capacity = value
            self._ack(True)
        elif mnem == b"GP":  # power readings
            fwd, rev, load = self._power_watts()
            self._ack(True)
            self._respond(struct.pack(">HHH", round(fwd * 10), round(rev * 10), round(load * 10)))
        elif mnem == b"GS":  # status/temp/mode/tuner
            data = (
                struct.pack(">H", self._status_word())
                + struct.pack(">H", round(self._temperature_c * 10))
                + struct.pack(">H", 1)  # operation mode: normal
                + struct.pack(">H", 3)  # tuner: analog tuner
            )
            self._ack(True)
            self._respond(data)
        elif mnem == b"GT":  # tuner/dc block
            data = (
                struct.pack(">H", 1 if self.manual_mode else 0)
                + struct.pack(">H", round(self.load_capacity * 10))
                + struct.pack(">H", round(self.tune_capacity * 10))
                + struct.pack(">H", 0)  # dc voltage
                + struct.pack(">H", 0)  # preset slot
            )
            self._ack(True)
            self._respond(data)
        elif mnem == b"Gp":  # power limits (20-byte block)
            block = bytearray(20)
            block[2:4] = struct.pack(">H", round(self.power_limit_w * 10))
            block[18:20] = struct.pack(">H", round(self.reverse_limit_w * 10))
            self._ack(True)
            self._respond(bytes(block))
        elif mnem == b"Gi":  # id / serial string
            text = self.id_string if p1 == b"\x00\x01" else self.serial_number
            self._ack(True)
            self._respond(b"\x00\x00" + text.encode() + b"\x00")
        elif mnem == b"Gf":  # firmware
            self._ack(True)
            self._respond(bytes(self.firmware))
        elif mnem == b"GF":  # frequency
            self._ack(True)
            self._respond(struct.pack(">L", self.frequency_hz))
        else:
            self._ack(False)
