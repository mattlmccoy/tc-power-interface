"""CXN wire-protocol codec.

Pure functions that build command frames and parse response frames for the T&C Power
Conversion AG-series generator (CXN dialect). Implemented from the documented protocol
(PyMeasure ``tccxn.py``, MIT; see plan/notes.md for byte-level citations).

Framing
-------
Command  (host -> device), always 10 bytes::

    b"C" | address(1) | command(6) | checksum(2, big-endian sum of preceding bytes)

Response (device -> host), read after a 1-byte acknowledgement (``*`` ok / ``?`` bad)::

    b"R" | address(1) | length(2, BE) | data(length) | checksum(2)

RF safety: this module only *builds bytes*. Nothing here opens a port or enables RF.
"""

from __future__ import annotations

import enum
import struct
from dataclasses import dataclass

# --- protocol constants -------------------------------------------------------------------
HEADER_CMD = ord("C")  # 0x43
HEADER_RESP = ord("R")  # 0x52
ACK_OK = b"*"
ACK_BAD = b"?"

#: Fixed serial-line settings for the CXN (pyserial keyword form).
SERIAL_SETTINGS = {"baudrate": 38400, "bytesize": 8, "parity": "N", "stopbits": 1}

#: Control lease must be refreshed at least this often or the device drops control / RF.
CONTROL_LEASE_TIMEOUT_S = 2.0

#: Documented maximum programmable setpoint (watts).
SETPOINT_MAX_W = 4000


class Status(enum.IntFlag):
    """CXN status word (from the ``GS`` response, bytes [0:2])."""

    RF_ENABLED = 1  # bit 0
    EXTERNAL_RFSOURCE = 16  # bit 4
    LOAD_POWER_LEVELING = 32  # bit 5
    MCG_MODE = 64  # bit 6
    FORWARD_POWER_LIMIT = 256  # bit 8
    REVERSE_POWER_LIMIT = 512  # bit 9
    OVER_TEMPERATURE = 1024  # bit 10
    INTERLOCK_OPEN = 2048  # bit 11
    ANALOG_INTERFACE = 16384  # bit 14


#: Operation-mode word (GS bytes [4:6]) -> name. 2 is documented as invalid.
OPERATION_MODES = {1: "normal", 2: "<invalid>", 3: "pulse", 4: "ramp"}

#: Tuner-type word (GS bytes [6:8]) -> name.
TUNER_TYPES = {1: "none", 2: "AFT generator", 3: "analog tuner", 4: "digital tuner"}


@dataclass(frozen=True)
class GtBlock:
    """Decoded tuner/DC block from a ``GT`` response."""

    manual_mode: bool
    load_capacity: float  # percent of full scale
    tune_capacity: float  # percent of full scale
    dc_voltage: int  # volts
    preset_slot: int


# --- framing ------------------------------------------------------------------------------
def checksum(msg: bytes) -> bytes:
    """Return the 2-byte big-endian sum of ``msg`` bytes."""
    return struct.pack(">H", sum(msg))


def encode_command(command: bytes, address: int = 0) -> bytes:
    """Wrap a 6-byte command field into a full 10-byte command frame."""
    if len(command) != 6:
        raise ValueError(f"command field must be 6 bytes, got {len(command)}")
    if not 0 <= address <= 255:
        raise ValueError(f"address must fit in one byte, got {address}")
    body = bytes([HEADER_CMD, address]) + command
    return body + checksum(body)


def decode_response(frame: bytes, address: int = 0) -> bytes:
    """Validate a complete response frame and return its data field.

    :raises ValueError: on short frame, bad header, wrong address, wrong length, or bad checksum.
    """
    if len(frame) < 6:
        raise ValueError(f"response too short: {len(frame)} bytes")
    header = frame[:4]
    if header[0] != HEADER_RESP:
        raise ValueError(f"invalid response header byte {header[0]!r}")
    if header[1] != address:
        raise ValueError(f"response address {header[1]} != expected {address}")
    datalength = int.from_bytes(header[2:4], "big")
    expected_len = 4 + datalength + 2
    if len(frame) != expected_len:
        raise ValueError(f"response length {len(frame)} != expected {expected_len}")
    data = frame[4 : 4 + datalength]
    received_checksum = frame[4 + datalength : expected_len]
    if received_checksum != checksum(header + data):
        raise ValueError("response checksum mismatch")
    return data


# --- response parsers ---------------------------------------------------------------------
def parse_power(data: bytes) -> tuple[float, float, float]:
    """Parse a ``GP`` response into (forward, reverse, load) watts."""
    fwd, rev, load = struct.unpack(">HHH", data)
    return (fwd / 10, rev / 10, load / 10)


def parse_status(data: bytes) -> Status:
    """Parse the status word (bytes [0:2] of a ``GS`` response)."""
    return Status(struct.unpack(">H", data[:2])[0])


def parse_temperature(data: bytes) -> float:
    """Parse heat-sink temperature (bytes [2:4] of a ``GS`` response) in deg C."""
    tenths: int = struct.unpack(">H", data[2:4])[0]
    return tenths / 10


def parse_frequency(data: bytes) -> int:
    """Parse a ``GF`` response into an operating frequency in Hz."""
    hz: int = struct.unpack(">L", data)[0]
    return hz


def parse_operation_mode(data: bytes) -> str:
    """Parse the operation mode (bytes [4:6] of a ``GS`` response)."""
    return OPERATION_MODES.get(struct.unpack(">H", data[4:6])[0], "<unknown>")


def parse_tuner(data: bytes) -> str:
    """Parse the tuner type (bytes [6:8] of a ``GS`` response)."""
    return TUNER_TYPES.get(struct.unpack(">H", data[6:8])[0], "<unknown>")


def parse_gt(data: bytes) -> GtBlock:
    """Parse a ``GT`` response into a :class:`GtBlock`."""
    manual = bool(struct.unpack(">H", data[0:2])[0] & 1)
    load = struct.unpack(">H", data[2:4])[0] / 10
    tune = struct.unpack(">H", data[4:6])[0] / 10
    dcv = struct.unpack(">H", data[6:8])[0]
    preset = struct.unpack(">H", data[8:10])[0]
    return GtBlock(manual_mode=manual, load_capacity=load, tune_capacity=tune,
                   dc_voltage=dcv, preset_slot=preset)


def parse_power_limit(data: bytes) -> float:
    """Parse the maximum forward power (bytes [2:4] of a ``Gp`` response) in watts."""
    tenths: int = struct.unpack(">H", data[2:4])[0]
    return tenths / 10


def parse_reverse_power_limit(data: bytes) -> float:
    """Parse the maximum reverse power (bytes [18:20] of a ``Gp`` response) in watts."""
    tenths: int = struct.unpack(">H", data[18:20])[0]
    return tenths / 10


def parse_id_string(data: bytes) -> str:
    """Parse a ``Gi`` identification/serial response (2-byte prefix, trailing byte)."""
    return data.decode(errors="replace")[2:-1].strip()


def parse_firmware(data: bytes) -> dict[str, str]:
    """Parse a ``Gf`` response into UI and RF firmware version strings."""
    ui_major, ui_minor, rf_major, rf_minor = struct.unpack("BBBB", data)
    return {"ui": f"{ui_major}.{ui_minor}", "rf": f"{rf_major}.{rf_minor}"}


# --- command builders ---------------------------------------------------------------------
def cmd_power() -> bytes:
    """Command to read forward/reverse/load power."""
    return b"GP\x00\x00\x00\x00"


def cmd_status() -> bytes:
    """Command to read the status/temperature/mode/tuner block."""
    return b"GS\x00\x00\x00\x00"


def cmd_rf_enable(on: bool) -> bytes:
    """Command to enable (0x55/0x55) or disable (0x00/0x00) the RF output."""
    return b"BR\x55\x55\x00\x00" if on else b"BR\x00\x00\x00\x00"


def cmd_request_control() -> bytes:
    """Command to request control of the generator."""
    return b"BC\x55\x55\x00\x00"


def cmd_release_control() -> bytes:
    """Command to release control (resets safe defaults, disables RF)."""
    return b"BC\x00\x00\x00\x00"


def cmd_ping() -> bytes:
    """Command to refresh the control lease without polling a value."""
    return b"BP\x00\x00\x00\x00"


def cmd_setpoint(watts: int) -> bytes:
    """Command to set the forward-power setpoint in watts."""
    if not 0 <= watts <= SETPOINT_MAX_W:
        raise ValueError(f"setpoint {watts} W out of range 0..{SETPOINT_MAX_W}")
    return b"SA" + watts.to_bytes(2, "big") + b"\x00\x00"


def cmd_id() -> bytes:
    """Command to read the device identification string."""
    return b"Gi\x00\x01\x00\x00"


def cmd_serial() -> bytes:
    """Command to read the serial number."""
    return b"Gi\x00\x02\x00\x00"


def cmd_firmware() -> bytes:
    """Command to read UI/RF firmware versions."""
    return b"Gf\x00\x00\x00\x00"


def cmd_frequency() -> bytes:
    """Command to read the operating frequency."""
    return b"GF\x00\x00\x00\x00"


def cmd_power_limit() -> bytes:
    """Command to read the forward/reverse power limits."""
    return b"Gp\x00\x00\x00\x00"


def cmd_gt() -> bytes:
    """Command to read the tuner/DC block (manual mode, capacities, DC voltage, preset)."""
    return b"GT\x00\x00\x00\x00"


def cmd_manual_mode() -> bytes:
    """Command to enable MANUAL tuner mode (TM 02).

    SAFETY: there is deliberately NO automatic (ATUNE, TM 01) command in this codec. The generator's
    built-in auto-tuner will damage the matching circuit and must never be engaged, so the byte
    sequence that would request it is not constructible here.
    """
    return b"TM\x00\x02\x00\x00"


def cmd_load_capacity(percent: float) -> bytes:
    """Command to set load-capacity percent (requires manual mode). 0.1% resolution."""
    if not 0 <= percent <= 100:
        raise ValueError(f"load capacity {percent}% out of range 0..100")
    return b"TC\x00\x01" + round(percent * 10).to_bytes(2, "big")


def cmd_tune_capacity(percent: float) -> bytes:
    """Command to set tune-capacity percent (requires manual mode). 0.1% resolution."""
    if not 0 <= percent <= 100:
        raise ValueError(f"tune capacity {percent}% out of range 0..100")
    return b"TC\x00\x02" + round(percent * 10).to_bytes(2, "big")
