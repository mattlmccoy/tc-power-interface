"""Tests for the toy simulated thermal source (demonstration model, not validated)."""

from tc_power_interface.control.temperature import SimulatedThermalSource


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
