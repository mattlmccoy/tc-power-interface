"""Shadow PI (spec §3.3): bounded, rate-limited, bumpless, and pure (it has nothing to actuate)."""

import inspect
import json
import math
from pathlib import Path

import pytest

from tc_power_interface.control import shadow_loop
from tc_power_interface.control.plant_estimator import PlantEstimate, PlantEstimator
from tc_power_interface.control.shadow_loop import (
    ShadowLoop,
    pi_gains,
    plateau_c,
    settle_time_s,
    time_to_target_s,
)

FIX = json.loads(
    (Path(__file__).parent / "fixtures/flir_20261002_125228_estimator.json").read_text()
)
GOOD = PlantEstimate(k_c_per_w=0.5, tau_s=150.0, confidence=0.8, t_amb_c=24.0, updates=50)


def test_simc_gains():
    kc, ti = pi_gains(0.5, 150.0)
    tc = max(150 / 2, 30)  # 75
    assert kc == pytest.approx(150 / (0.5 * (tc + shadow_loop.DEAD_TIME_S)))
    assert ti == pytest.approx(min(150, 4 * (tc + shadow_loop.DEAD_TIME_S)))


def test_plateau_time_to_target_and_settle():
    assert plateau_c(24.0, 0.5, 70.0) == pytest.approx(59.0)
    assert time_to_target_s(59.0, 55.0, 40.0, 150.0) == pytest.approx(-150 * math.log(4 / 19))
    assert time_to_target_s(50.0, 55.0, 40.0, 150.0) is None  # levels off below the target
    assert time_to_target_s(59.0, 55.0, 56.0, 150.0) is None  # already above it
    assert settle_time_s(59.0, 40.0, 150.0) == pytest.approx(150 * math.log(19))
    assert settle_time_s(59.0, 58.5, 150.0) == 0.0  # within 1 °C already


def test_no_suggestion_without_a_valid_estimate_or_temperature():
    sl = ShadowLoop()
    none_est = PlantEstimate(None, None, 0.0, 24.0, 2)
    out = sl.step(none_est, temp_c=30.0, power_w=40.0, target_c=55.0, ceiling_w=200)
    assert out.suggest_w is None
    out = sl.step(GOOD, temp_c=None, power_w=40.0, target_c=55.0, ceiling_w=200)
    assert out.suggest_w is None


def test_bumpless_start_rate_limit_and_ceiling():
    sl = ShadowLoop()
    first = sl.step(GOOD, temp_c=25.0, power_w=40.0, target_c=200.0, ceiling_w=120).suggest_w
    assert first == pytest.approx(50.0)  # starts from YOUR 40 W, moves at most 10 W
    outs = [
        sl.step(GOOD, temp_c=25.0, power_w=40.0, target_c=200.0, ceiling_w=120).suggest_w
        for _ in range(30)
    ]
    assert all(b - a <= 10.0 + 1e-9 for a, b in zip([first, *outs], outs, strict=False))
    assert max(outs) == pytest.approx(120.0)  # clamped to the ceiling


def test_reset_forgets_the_integral():
    sl = ShadowLoop()
    for _ in range(20):
        sl.step(GOOD, temp_c=25.0, power_w=40.0, target_c=200.0, ceiling_w=120)
    sl.reset()
    out = sl.step(GOOD, temp_c=25.0, power_w=40.0, target_c=200.0, ceiling_w=120)
    assert out.suggest_w == pytest.approx(50.0)


def test_real_run_suggests_a_physical_hold_power():
    est, sl, out = PlantEstimator(), ShadowLoop(), None
    series = zip(
        FIX["t_s"], FIX["forward_w"], FIX["rois"]["freehand_sample"], strict=True
    )
    for t, p, temp in series:
        e = est.add(t, p, temp, rf_on=p >= 1)
        out = sl.step(e, temp_c=temp, power_w=p, target_c=55.0, ceiling_w=200)
    # Steady-state hold for 55 °C from T_amb 23.8 at K 0.526 is ~59 W; measured suggestion ~51.6 W.
    assert 50.0 <= out.suggest_w <= 75.0


def test_module_has_no_actuator_access():
    src = inspect.getsource(shadow_loop)
    for forbidden in ("set_setpoint", "enable_rf", "set_tune", "set_load", "controller"):
        assert forbidden not in src
