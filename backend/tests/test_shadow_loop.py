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
    assert all(abs(b - a) <= 10.0 + 1e-9 for a, b in zip([first, *outs], outs, strict=False))
    assert max(outs) == pytest.approx(120.0)  # clamped to the ceiling


def test_reset_forgets_the_integral():
    sl = ShadowLoop()
    for _ in range(20):
        sl.step(GOOD, temp_c=25.0, power_w=40.0, target_c=200.0, ceiling_w=120)
    sl.reset()
    out = sl.step(GOOD, temp_c=25.0, power_w=40.0, target_c=200.0, ceiling_w=120)
    assert out.suggest_w == pytest.approx(50.0)


def _step(sl, temp, power=40.0, target=200.0, ceiling=120.0, est=GOOD):
    return sl.step(est, temp_c=temp, power_w=power, target_c=target, ceiling_w=ceiling).suggest_w


def test_above_target_decreases_monotonically_and_floors_at_zero():
    sl = ShadowLoop()
    outs = [_step(sl, 60.0, power=40.0, target=55.0) for _ in range(40)]
    assert outs[0] < 40.0
    assert all(b <= a + 1e-9 for a, b in zip(outs, outs[1:], strict=False))
    assert outs[-1] == 0.0


def test_downward_steps_are_rate_limited_too():
    sl = ShadowLoop()
    outs = [_step(sl, 90.0, power=100.0, target=55.0) for _ in range(20)]
    seq = [100.0, *outs]
    assert all(abs(b - a) <= 10.0 + 1e-9 for a, b in zip(seq, seq[1:], strict=False))
    assert outs[0] == pytest.approx(90.0)


def test_dropout_resets_so_the_next_start_is_bumpless_from_current_power():
    sl = ShadowLoop()
    for _ in range(30):
        _step(sl, 25.0, power=20.0, target=55.0)
    none_est = PlantEstimate(None, None, 0.0, 24.0, 2)
    out = sl.step(none_est, temp_c=30.0, power_w=20.0, target_c=55.0, ceiling_w=200)
    assert out.suggest_w is None
    out = _step(sl, 25.0, power=60.0, target=55.0, ceiling=200.0)
    assert 50.0 <= out <= 70.0


def test_missing_temperature_also_resets():
    sl = ShadowLoop()
    for _ in range(30):
        _step(sl, 25.0, power=20.0, target=55.0)
    assert _step(sl, None, power=20.0, target=55.0) is None
    out = _step(sl, 25.0, power=60.0, target=55.0, ceiling=200.0)
    assert 50.0 <= out <= 70.0


def test_anti_windup_integral_does_not_grow_while_saturated():
    sl = ShadowLoop()
    for _ in range(100):  # err +15 against a 120 W ceiling: saturated
        _step(sl, 25.0, power=40.0, target=40.0, ceiling=120.0)
    outs = [_step(sl, 56.0, power=40.0, target=55.0, ceiling=120.0) for _ in range(50)]
    assert min(outs) < 80.0


@pytest.mark.parametrize("bad", ["temp", "target", "power", "ceiling"])
def test_non_finite_input_returns_none_and_restarts_bumpless(bad):
    sl = ShadowLoop()
    for _ in range(30):
        _step(sl, 25.0, power=20.0, target=55.0, ceiling=200.0)
    args = {"temp_c": 25.0, "power_w": 20.0, "target_c": 55.0, "ceiling_w": 200.0}
    key = {"temp": "temp_c", "target": "target_c", "power": "power_w", "ceiling": "ceiling_w"}[bad]
    args[key] = math.nan
    assert sl.step(GOOD, **args).suggest_w is None
    out = _step(sl, 25.0, power=60.0, target=55.0, ceiling=200.0)
    assert out is not None and 50.0 <= out <= 70.0


def test_power_above_ceiling_is_clamped_on_the_first_suggestion():
    sl = ShadowLoop()
    out = _step(sl, 25.0, power=140.0, target=200.0, ceiling=120.0)
    assert out <= 120.0


def test_real_run_suggests_a_physical_hold_power():
    est, sl, out = PlantEstimator(), ShadowLoop(), None
    series = zip(FIX["t_s"], FIX["forward_w"], FIX["rois"]["freehand_sample"], strict=True)
    for t, p, temp in series:
        e = est.add(t, p, temp, rf_on=p >= 1)
        out = sl.step(e, temp_c=temp, power_w=p, target_c=55.0, ceiling_w=200)
    # Steady-state hold for 55 °C from T_amb 23.8 at K 0.526 is ~59 W; the PI may sit above it.
    assert 50.0 <= out.suggest_w <= 75.0
    # regression pin (2026-10-07, DEAD_TIME_S=0); re-pin if DEAD_TIME_S changes
    assert out.suggest_w == pytest.approx(72.3, abs=2.0)


def test_module_has_no_actuator_access():
    src = inspect.getsource(shadow_loop)
    for forbidden in ("set_setpoint", "enable_rf", "set_tune", "set_load", "controller"):
        assert forbidden not in src
