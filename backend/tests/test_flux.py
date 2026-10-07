import pytest

from tc_power_interface.analysis.flux import LoopGeometry, ScopeLimits, b_pk_mt, limit_flags


def test_one_core_coefficient_matches_record():
    assert b_pk_mt(1.0, 13.56e6, LoopGeometry()) == pytest.approx(0.1051, rel=1e-3)


def test_90w_capture_is_7_2_mt():
    assert b_pk_mt(68.8334, 13.56e6, LoopGeometry()) == pytest.approx(7.23, abs=0.01)


def test_two_core_loop_halves_b():
    one = b_pk_mt(50.0, 13.56e6, LoopGeometry(cores_linked=1))
    two = b_pk_mt(50.0, 13.56e6, LoopGeometry(cores_linked=2))
    assert two == pytest.approx(one / 2)


def test_six_mt_stop_is_57_volts_one_core():
    assert b_pk_mt(57.11, 13.56e6, LoopGeometry()) == pytest.approx(6.0, abs=0.01)


def test_geometry_rejects_nonpositive():
    with pytest.raises(ValueError):
        LoopGeometry(turns=0)
    with pytest.raises(ValueError):
        LoopGeometry(ae_per_core_m2=0.0)


def test_limit_flags():
    lim = ScopeLimits()
    assert limit_flags(40.0, 4.2, lim) == ()
    assert limit_flags(66.0, 5.0, lim) == ("probe_warn",)
    assert limit_flags(71.0, 5.0, lim) == ("probe_hard",)
    assert limit_flags(58.0, 6.1, lim) == ("flux_stop",)
    assert limit_flags(71.0, 7.5, lim) == ("probe_hard", "flux_stop")
    assert limit_flags(71.0, None, lim) == ("probe_hard",)
