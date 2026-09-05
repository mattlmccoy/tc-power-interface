"""Tests for the FLIR-backed temperature source (apply a frame -> read() returns that stat).

The live /ws/frames socket is integration-only; here we drive the pure ``apply_frame`` path with a
synthetic FLIR frame built to the documented wire format (see tests/test_flir_integration.py).
"""

import json
import struct

from tc_power_interface.integration.flir_temperature import FlirTemperatureSource


def _flir_message(header: dict, counts: bytes = b"\x00\x01\x02\x03") -> bytes:
    hjson = json.dumps(header).encode()
    return struct.pack(">I", len(hjson)) + hjson + counts


def test_invalid_until_a_frame_arrives():
    src = FlirTemperatureSource("ws://localhost:8000/ws/frames")
    s = src.read()
    assert s.valid is False  # no frame yet -> not a real reading


def test_apply_frame_updates_reading():
    src = FlirTemperatureSource("ws://localhost:8000/ws/frames", stat="center_c")
    src.apply_frame(_flir_message({"center_c": 213.6, "max_c": 260.0}))
    s = src.read()
    assert s.valid is True
    assert s.celsius == 213.6


def test_uses_configured_stat():
    src = FlirTemperatureSource("ws://localhost:8000/ws/frames", stat="mean_c")
    src.apply_frame(_flir_message({"center_c": 213.6, "mean_c": 160.1}))
    assert src.read().celsius == 160.1


def test_bad_frame_keeps_last_good_value():
    src = FlirTemperatureSource("ws://localhost:8000/ws/frames", stat="center_c")
    src.apply_frame(_flir_message({"center_c": 150.0}))
    src.apply_frame(b"\x00")  # truncated -> ignored
    s = src.read()
    assert s.valid is True
    assert s.celsius == 150.0


def test_has_no_step_method():
    # The ThermalController only steps sources that expose .step (the sim model); the FLIR source
    # is driven by real frames, so it must NOT look steppable.
    assert not hasattr(FlirTemperatureSource("ws://x"), "step")
