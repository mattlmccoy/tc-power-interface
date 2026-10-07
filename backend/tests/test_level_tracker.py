"""Level assignment: commanded setpoint, settled only.

The real-data test pins the 1.0 W default tolerance.
"""

import csv
from pathlib import Path

import pytest

from tc_power_interface.control.level_tracker import LevelState, LevelTracker

FIX = Path(__file__).parent / "fixtures" / "scope"


def test_rf_off_and_no_setpoint():
    lt = LevelTracker()
    assert lt.update(0.0, setpoint_w=50, forward_w=0.0, rf_on=False).state is LevelState.RF_OFF
    no_sp = lt.update(1.0, setpoint_w=None, forward_w=50.5, rf_on=True)
    assert no_sp.state is LevelState.NO_SETPOINT


def test_settles_after_settle_s_then_assigns():
    lt = LevelTracker(tol_w=1.0, settle_s=3.0)
    assert lt.update(0.0, setpoint_w=50, forward_w=50.5, rf_on=True).state is LevelState.SETTLING
    assert lt.update(2.9, setpoint_w=50, forward_w=50.5, rf_on=True).state is LevelState.SETTLING
    a = lt.update(3.0, setpoint_w=50, forward_w=50.6, rf_on=True)
    assert a.state is LevelState.ASSIGNED and a.level_w == 50


def test_off_setpoint_resets_settle_clock():
    lt = LevelTracker(tol_w=1.0, settle_s=3.0)
    lt.update(0.0, setpoint_w=50, forward_w=50.5, rf_on=True)
    off = lt.update(2.0, setpoint_w=50, forward_w=60.5, rf_on=True)
    assert off.state is LevelState.OFF_SETPOINT
    assert lt.update(4.0, setpoint_w=50, forward_w=50.5, rf_on=True).state is LevelState.SETTLING
    assert lt.update(7.0, setpoint_w=50, forward_w=50.5, rf_on=True).state is LevelState.ASSIGNED


def test_setpoint_change_restarts_settling():
    lt = LevelTracker(tol_w=1.0, settle_s=3.0)
    lt.update(0.0, setpoint_w=50, forward_w=50.5, rf_on=True)
    lt.update(3.0, setpoint_w=50, forward_w=50.5, rf_on=True)
    assert lt.update(3.5, setpoint_w=60, forward_w=60.4, rf_on=True).state is LevelState.SETTLING


def test_real_powersweep_offsets_fit_default_tolerance_not_half_watt():
    # 10-06 ramp: forward reads +0.4..+0.6 W over the nominal 5/10/20…90 W step (setpoint was
    # not logged; the nominal steps are the operator's folder labels). Default 1.0 W must accept
    # every plateau row; 0.5 W would reject some — the reason the spec default changed.
    steps = [5, 10, 20, 30, 40, 50, 60, 70, 80, 90]
    rows = list(csv.DictReader((FIX / "powersweep_core2_telemetry.csv").open()))
    fwd = [float(r["forward_w"]) for r in rows if float(r["forward_w"]) > 1.0]
    dev = [min(abs(p - s) for s in steps) for p in fwd]
    plateau = [d for d in dev if d <= 1.5]  # exclude ramp-transition rows
    assert len(plateau) > 600
    assert max(plateau) <= LevelTracker().tol_w
    assert any(d > 0.5 for d in plateau)


def test_rejects_bad_config():
    with pytest.raises(ValueError):
        LevelTracker(tol_w=0)
