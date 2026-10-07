import math

import pytest

from tc_power_interface.analysis.scope_summary import session_mt_per_sqrtw, summarize_levels


def _row(level, vrms, b, valid=True, f0=13.56e6):
    return {
        "level_w": level,
        "vrms_v": vrms,
        "b_pk_mt": b,
        "f0_hz": f0,
        "h2_pct": 0.3,
        "h3_pct": 0.2,
        "valid": valid,
    }


def test_summary_groups_valid_assigned_rows_only():
    rows = [
        _row(50, 50.0, 5.25),
        _row(50, 50.2, 5.27),
        _row(50, 99.0, 9.9, valid=False),
        _row(None, 30.0, 3.1),
    ]
    (s,) = summarize_levels(rows)
    assert s.level_w == 50 and s.n == 2
    assert s.vrms_median_v == pytest.approx(50.1)
    assert s.v_per_sqrtw == pytest.approx(50.1 / math.sqrt(50))


def test_session_fit_uses_only_levels_at_or_above_10w():
    rows = [_row(5, 99.0, 9.9)] + [_row(w, 0, 0.75 * math.sqrt(w)) for w in (10, 40, 90)]
    k = session_mt_per_sqrtw(summarize_levels(rows), min_level_w=10.0)
    assert k == pytest.approx(0.75)


def test_zero_level_rows_are_ignored():
    assert summarize_levels([_row(0, 1.0, 0.1)]) == []


def test_session_fit_none_without_eligible_levels():
    assert session_mt_per_sqrtw(summarize_levels([_row(5, 10, 1.0)]), min_level_w=10.0) is None


def test_zero_median_b_is_kept_in_fit():
    rows = [_row(10, 1.0, 0.0), _row(40, 1.0, 1.5)]
    k = session_mt_per_sqrtw(summarize_levels(rows), min_level_w=10.0)
    # x=[sqrt10, sqrt40], y=[0, 1.5]: slope = (sqrt40*1.5)/(10+40)
    assert k == pytest.approx(math.sqrt(40) * 1.5 / 50)
