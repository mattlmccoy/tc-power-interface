from tc_power_interface.analysis.scope_flags import SessionFlagger


def _feed(f, t, level, vrms, resid=0.7, h2=0.3):
    return f.update(t_s=t, level_w=level, vrms_v=vrms, resid_v=resid, h2_pct=h2)


def test_no_flags_while_building_baseline_and_when_steady():
    f = SessionFlagger()
    for i in range(10):
        assert _feed(f, float(i), 50, 50.1) == ()


def test_seating_flag_when_residual_jumps():
    f = SessionFlagger()
    for i in range(5):
        _feed(f, float(i), 50, 50.1, resid=0.7)
    assert "seating" in _feed(f, 6.0, 50, 45.0, resid=2.5)


def test_detune_flag_when_v_per_sqrtw_falls_over_30s():
    f = SessionFlagger()
    for i in range(0, 31):
        out = _feed(f, float(i), 90, 68.8 if i < 30 else 64.0)
    assert "detune" in out


def test_unassigned_readings_never_flag():
    f = SessionFlagger()
    assert _feed(f, 0.0, None, 10.0, resid=99) == ()
