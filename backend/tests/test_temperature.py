"""Tests for the toy simulated thermal source (demonstration model, not validated)."""

import pytest

from tc_power_interface.control.temperature import (
    RecordedTemperatureSource,
    SimulatedThermalSource,
)


def test_starts_at_ambient():
    src = SimulatedThermalSource(ambient_c=25.0)
    s = src.read()
    assert s.valid is True
    assert s.celsius == 25.0


def test_heats_toward_a_power_dependent_steady_state():
    # k_heat/k_cool = 1.25 -> steady T = ambient + 1.25 * P.  At 100 W: ~150 C.
    src = SimulatedThermalSource(ambient_c=25.0, k_heat=0.125, k_cool=0.1)
    for _ in range(400):
        src.step(load_w=100.0, dt_s=0.1)
    assert 145.0 < src.read().celsius < 155.0


def test_cools_toward_ambient_with_no_power():
    src = SimulatedThermalSource(ambient_c=25.0, k_heat=0.125, k_cool=0.1)
    for _ in range(200):
        src.step(load_w=100.0, dt_s=0.1)  # heat up
    for _ in range(600):
        src.step(load_w=0.0, dt_s=0.1)  # then cool
    assert src.read().celsius < 40.0


# --- RecordedTemperatureSource: replay a real recorded (t, temp) trace -----------------------


def test_recorded_reads_first_sample_before_advance():
    src = RecordedTemperatureSource([0.0, 1.0, 2.0], [25.0, 100.0, 150.0])
    s = src.read()
    assert s.valid is True
    assert s.celsius == 25.0


def test_recorded_interpolates_between_samples():
    src = RecordedTemperatureSource([0.0, 1.0, 2.0], [20.0, 40.0, 80.0])
    src.advance(0.5)  # halfway between t=0 (20) and t=1 (40)
    assert src.read().celsius == pytest.approx(30.0)
    src.advance(1.0)  # now at t=1.5, halfway between 40 and 80
    assert src.read().celsius == pytest.approx(60.0)


def test_recorded_holds_last_value_past_the_end():
    src = RecordedTemperatureSource([0.0, 1.0], [25.0, 90.0])
    src.advance(5.0)
    assert src.read().celsius == 90.0


def test_recorded_requires_matching_nonempty_arrays():
    with pytest.raises(ValueError):
        RecordedTemperatureSource([], [])
    with pytest.raises(ValueError):
        RecordedTemperatureSource([0.0, 1.0], [25.0])
