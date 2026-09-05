"""Tests for parsing the FLIR Research Interface frame message header.

The FLIR /ws/frames wire format is: [4-byte big-endian header length][UTF-8 JSON header][counts].
We only need the JSON header (it carries server-computed ROI/stat temperatures like center_c).
The binary counts payload is ignored here. Fixture is built to the documented FLIR wire format.
"""

import json
import struct

from tc_power_interface.integration.flir_client import control_temperature, parse_flir_header


def _flir_message(header: dict, counts: bytes = b"\x00\x01\x02\x03") -> bytes:
    hjson = json.dumps(header).encode()
    return struct.pack(">I", len(hjson)) + hjson + counts


def test_parse_header_returns_json_dict_ignoring_counts():
    header = {"type": "frame", "frame_id": 42, "center_c": 213.6, "max_c": 260.0}
    msg = _flir_message(header)
    parsed = parse_flir_header(msg)
    assert parsed["frame_id"] == 42
    assert parsed["center_c"] == 213.6


def test_control_temperature_selects_named_stat():
    header = {"center_c": 213.6, "mean_c": 160.1, "max_c": 260.0}
    msg = _flir_message(header)
    assert control_temperature(msg, stat="center_c") == 213.6
    assert control_temperature(msg, stat="mean_c") == 160.1
