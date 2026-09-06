"""Dither law: with magnitude-only feedback, keep a cap's direction while reverse power falls, and
reverse it when reverse power rises."""

from tc_power_interface.control.match_tuner import observe


def test_keeps_direction_when_improving():
    # reverse power fell by more than eps -> keep going the same way
    assert observe(prev=0.30, curr=0.25, direction=+1, eps=0.005) == (+1, True)


def test_reverses_direction_when_worse():
    assert observe(prev=0.25, curr=0.30, direction=+1, eps=0.005) == (-1, False)


def test_reverses_when_flat_within_eps():
    # no real improvement -> treat as not-improving and reverse to probe the other way
    assert observe(prev=0.2500, curr=0.2490, direction=-1, eps=0.005) == (+1, False)
