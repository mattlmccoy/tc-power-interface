"""Room temperature for the shadow loop: a part at rest, else the operator's reference ROI, else
unknown.

The histories here are synthetic on purpose: no recording holds an at-rest stretch before RF (see
docs/superpowers/plans/2026-10-08-shadow-room-temperature.md). The real warm start is exercised
in test_cockpit_ambient.py.
"""

import math

import pytest

from tc_power_interface.control.ambient import judge_ambient


def _hist(slope_c_per_min, *, t_on=100.0, span_s=70.0, start_c=22.8, rf=False, step=0.5):
    """RF-off readings every ``step`` s over ``span_s`` s before ``t_on``, at a constant slope."""
    out, t = [], t_on - span_s
    while t < t_on:
        out.append((t, start_c + slope_c_per_min * (t - (t_on - span_s)) / 60.0, rf))
        t += step
    return out


def test_part_at_rest_gives_the_mean_of_the_window():
    a = judge_ambient(_hist(0.0), t_on=100.0, ref_roi=None, ref_temp_c=None)
    assert a.source == "part_at_rest" and a.reason is None
    assert a.t_amb_c == pytest.approx(22.8, abs=1e-6)
    assert abs(a.slope_c_per_min) < 1e-6


def test_slow_drift_below_the_limit_still_counts_as_rest():
    a = judge_ambient(_hist(0.2), t_on=100.0, ref_roi=None, ref_temp_c=None)
    assert a.source == "part_at_rest"


def test_a_cooling_part_is_not_room_temperature():
    # run 20261007_171928 began ~1.8 C/min cooling (29.1 C, 22.8 C room, tau ~214 s)
    a = judge_ambient(_hist(-1.8, start_c=31.0), t_on=100.0, ref_roi=None, ref_temp_c=None)
    assert a.t_amb_c is None and a.source is None and a.reason == "part_cooling"
    assert a.slope_c_per_min == pytest.approx(-1.8, abs=0.01)


def test_a_warming_part_is_not_room_temperature():
    a = judge_ambient(_hist(1.0), t_on=100.0, ref_roi=None, ref_temp_c=None)
    assert a.t_amb_c is None and a.reason == "part_warming"


def test_rf_on_inside_the_window_means_the_part_was_just_heated():
    h = _hist(0.0)
    h[-20] = (h[-20][0], h[-20][1], True)
    a = judge_ambient(h, t_on=100.0, ref_roi=None, ref_temp_c=None)
    assert a.t_amb_c is None and a.reason == "rf_recent"


@pytest.mark.parametrize(
    "hist",
    [
        [],
        _hist(0.0, span_s=30.0),  # too short
        [(t, c, rf) for t, c, rf in _hist(0.0) if t < 90.0],  # nothing in the last 5 s
        [(t, c, rf) for t, c, rf in _hist(0.0) if not (50.0 < t < 90.0)],  # a 40 s hole
    ],
    ids=["empty", "short", "stale", "gappy"],
)
def test_too_little_history_is_unknown_not_rest(hist):
    a = judge_ambient(hist, t_on=100.0, ref_roi=None, ref_temp_c=None)
    assert a.t_amb_c is None and a.reason == "no_history"


def test_unknown_readings_are_ignored_not_counted_as_rest():
    h = [(t, math.nan, rf) for t, _, rf in _hist(0.0)]
    a = judge_ambient(h, t_on=100.0, ref_roi=None, ref_temp_c=None)
    assert a.t_amb_c is None and a.reason == "no_history"


def test_reference_roi_covers_a_warm_start_and_keeps_the_reason():
    a = judge_ambient(_hist(-1.8, start_c=31.0), t_on=100.0, ref_roi="wall", ref_temp_c=23.1)
    assert a.t_amb_c == 23.1 and a.source == "reference" and a.reference_roi == "wall"
    assert a.reason == "part_cooling"


def test_a_rested_part_beats_the_reference():
    a = judge_ambient(_hist(0.0), t_on=100.0, ref_roi="shunt_cap_FP", ref_temp_c=24.1)
    assert a.source == "part_at_rest" and a.t_amb_c == pytest.approx(22.8)


@pytest.mark.parametrize("ref", [None, math.nan, math.inf])
def test_an_unreadable_reference_does_not_count(ref):
    a = judge_ambient(_hist(-1.8, start_c=31.0), t_on=100.0, ref_roi="wall", ref_temp_c=ref)
    assert a.t_amb_c is None and a.source is None and a.reason == "part_cooling"


def test_history_after_rf_on_is_ignored():
    h = _hist(0.0) + [(100.0 + i, 40.0 + i, True) for i in range(10)]
    a = judge_ambient(h, t_on=100.0, ref_roi=None, ref_temp_c=None)
    assert a.source == "part_at_rest" and a.t_amb_c == pytest.approx(22.8)


def test_unknown_rf_state_inside_the_window_is_not_rest():
    h = _hist(0.0)
    h[-30] = (h[-30][0], h[-30][1], None)  # a reading taken with no generator attached
    a = judge_ambient(h, t_on=100.0, ref_roi=None, ref_temp_c=None)
    assert a.t_amb_c is None and a.reason == "rf_unknown"
