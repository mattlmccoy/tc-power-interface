"""Tests for persisting the editable safety limits to a .safety_limits.json sidecar."""

from tc_power_interface.control.safety import SafetyLimits
from tc_power_interface.control.safety_store import load_limits, save_limits


def test_load_missing_returns_defaults(tmp_path):
    assert load_limits(tmp_path) == SafetyLimits()


def test_roundtrip_clamped(tmp_path):
    save_limits(tmp_path, SafetyLimits(max_forward_w=300, max_reflected_w=40, temperature_c_trip=65))
    loaded = load_limits(tmp_path)
    assert (loaded.max_forward_w, loaded.max_reflected_w, loaded.temperature_c_trip) == (
        300,
        40.0,
        65.0,
    )


def test_load_clamps_out_of_range_file(tmp_path):
    (tmp_path / ".safety_limits.json").write_text(
        '{"max_forward_w": 9999, "max_reflected_w": 9999, "temperature_c_trip": 999}'
    )
    loaded = load_limits(tmp_path)
    assert loaded.max_forward_w == 400
    assert loaded.max_reflected_w == 200.0
    assert loaded.temperature_c_trip == 90.0
