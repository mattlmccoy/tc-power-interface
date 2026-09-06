"""The simulator's reverse-power well: a sharp-in-tune, broad-in-load minimum at (t_opt, l_opt)."""

from tc_power_interface.device.reflection import CEILING, FLOOR, reflected_fraction


def test_minimum_at_optimum():
    assert reflected_fraction(50, 50, 50, 50) == FLOOR


def test_far_from_optimum_approaches_ceiling():
    r = reflected_fraction(0, 0, 90, 90)
    assert r > 0.8
    assert r <= CEILING


def test_tune_is_sharper_than_load():
    # An equal cap offset costs far more reverse power in tune than in load.
    dt = reflected_fraction(55, 50, 50, 50)  # +5% tune
    dl = reflected_fraction(50, 55, 50, 50)  # +5% load
    assert dt > dl


def test_monotonic_in_each_axis_moving_away():
    base = reflected_fraction(50, 50, 50, 50)
    assert reflected_fraction(52, 50, 50, 50) > base
    assert reflected_fraction(50, 60, 50, 50) > base
