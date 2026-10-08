"""Live first-order plant estimate (spec §3.2).

Real-data expectations come from the captured 10-02 run.
"""
import json
import math
import random
from pathlib import Path

import pytest

from tc_power_interface.control.plant_estimator import COV_INIT, PlantEstimator

FIX = json.loads(
    (Path(__file__).parent / "fixtures/flir_20261002_125228_estimator.json").read_text()
)
SERIES = list(zip(FIX["t_s"], FIX["forward_w"], FIX["rois"]["freehand_sample"], strict=True))


def _simulate(k, tau, profile, noise, dt=0.5, t0=24.0, seed=0, gap=None, corrupt=None):
    """First-order plant dT/dt = (K/tau)P - (T-T0)/tau, sampled every dt with seeded noise.

    gap=(t_start, t_end) drops every telemetry tick in that window (the plant keeps evolving);
    corrupt=f(t, temp, power) -> (temp, power) lets a test inject bad readings.
    """
    rng = random.Random(seed)
    est, temp, out = PlantEstimator(), t0, None
    for n in range(int(profile[-1][0] / dt)):
        t = n * dt
        p = next(w for t_end, w in profile if t < t_end)
        temp += (k / tau * p - (temp - t0) / tau) * dt
        if gap is not None and gap[0] <= t < gap[1]:
            continue
        reading, power = temp + rng.gauss(0, noise), p
        if corrupt is not None:
            reading, power = corrupt(t, reading, power)
        out = est.add(t, power, reading, rf_on=True)
    return out


STEPS = [(180, 20), (360, 40), (540, 60), (720, 40)]


def test_power_steps_recover_gain_and_time_constant_within_10_percent():
    steps = [(180, 20), (360, 40), (540, 60), (720, 40)]
    for k, tau in [(0.5, 150), (0.15, 200)]:
        e = _simulate(k, tau, steps, noise=0.05)
        assert e.valid
        assert abs(e.k_c_per_w - k) / k < 0.10
        assert abs(e.tau_s - tau) / tau < 0.10
        assert e.confidence > 0.8


def test_no_estimate_in_the_first_two_minutes_of_steady_power():
    e = _simulate(0.5, 150, [(120, 40)], noise=0.1)
    assert not e.valid and e.confidence == 0.0 and e.k_c_per_w is None


def test_unknown_temperature_is_skipped_never_treated_as_zero():
    est = PlantEstimator()
    for n in range(200):
        t = n * 5.0
        temp = None if n % 10 == 0 else 24 + 0.05 * n
        e = est.add(t, 40.0, temp, rf_on=True)
    assert e.t_amb_c is not None and e.t_amb_c > 20  # never 0 from a missing reading


def test_rf_off_samples_do_not_update():
    est = PlantEstimator()
    for n in range(100):
        e = est.add(n * 5.0, 40.0, 24.0 + n * 0.1, rf_on=False)
    assert e.updates == 0 and not e.valid


def test_real_run_converges_and_is_unsure_early():
    est = PlantEstimator()
    mid = None
    for i, (t, p, temp) in enumerate(SERIES):
        e = est.add(t, p, temp, rf_on=p >= 1)
        if i == 100:
            mid = e
    assert mid is not None and mid.confidence < 0.3  # 8.3 min: steady power, not yet separable
    assert 0.35 <= e.k_c_per_w <= 0.65  # measured 0.526
    assert 100 <= e.tau_s <= 250  # measured 208 s
    assert e.confidence >= 0.5  # measured 0.76
    assert abs(e.t_amb_c - 23.79) < 0.01


def test_reset_starts_a_new_run():
    est = PlantEstimator()
    for t, p, temp in SERIES:
        est.add(t, p, temp, rf_on=p >= 1)
    est.reset()
    assert est.estimate().updates == 0 and est.estimate().t_amb_c is None


def test_a_telemetry_gap_does_not_compress_time():
    # 120 s of dropped ticks mid-run: the derivative must never span the hole.
    e = _simulate(0.5, 150, STEPS, noise=0.05, gap=(300, 420))
    assert e.valid
    assert abs(e.tau_s - 150) / 150 < 0.10
    assert abs(e.k_c_per_w - 0.5) / 0.5 < 0.10


def test_slow_ticks_are_never_confidently_wrong():
    # 6 s ticks do not fit the 5 s grid; the estimate may refuse, but must not be wrong.
    e = _simulate(0.5, 150, STEPS, noise=0.05, dt=6.0)
    assert (not e.valid) or abs(e.tau_s - 150) / 150 < 0.10


def test_a_nan_temperature_does_not_poison_the_filter():
    def corrupt(t, temp, power):
        return (float("nan"), power) if 300 <= t < 301 else (temp, power)

    e = _simulate(0.5, 150, STEPS, noise=0.05, corrupt=corrupt)
    assert e.valid and math.isfinite(e.k_c_per_w) and math.isfinite(e.tau_s)
    assert abs(e.k_c_per_w - 0.5) / 0.5 < 0.10
    assert abs(e.tau_s - 150) / 150 < 0.10


def test_a_nan_or_inf_power_is_treated_as_zero_not_poison():
    def corrupt(t, temp, power):
        if 300 <= t < 301:
            return temp, float("nan")
        if 400 <= t < 401:
            return temp, float("inf")
        return temp, power

    e = _simulate(0.5, 150, STEPS, noise=0.05, corrupt=corrupt)
    assert e.valid and math.isfinite(e.k_c_per_w) and math.isfinite(e.tau_s)
    assert abs(e.tau_s - 150) / 150 < 0.10


def test_two_hour_steady_hold_does_not_wind_up_the_covariance():
    hold = STEPS + [(720 + 7200, 40)]
    e = _simulate(0.5, 150, hold, noise=0.05)
    assert e.valid
    assert abs(e.k_c_per_w - 0.5) / 0.5 < 0.10
    assert abs(e.tau_s - 150) / 150 < 0.10
    assert e.confidence >= 0.5


def test_zero_confidence_fit_is_reported_as_still_learning():
    # Pins the confidence>0 gate: >=6 updates and a,b>0, but the covariance says the fit is noise.
    est = PlantEstimator()
    est._theta, est._cov, est._r2, est._n = [0.01, 0.02], [[1.0, 0.0], [0.0, 1.0]], 1.0, 10
    e = est.estimate()
    assert not e.valid and e.confidence == 0.0 and e.k_c_per_w is None and e.tau_s is None


def test_half_second_ticks_give_one_sample_per_five_seconds():
    est = PlantEstimator()
    for n in range(1440):  # 720 s
        est.add(n * 0.5, 40.0, 24.0, rf_on=True)
    assert est.grid_samples == 144


def test_a_late_tick_takes_its_slot_and_the_grid_does_not_drift():
    est = PlantEstimator()
    est.add(0.0, 40.0, 24.0, rf_on=True)
    est.add(5.3, 40.0, 24.0, rf_on=True)  # late: still one sample
    assert est.grid_samples == 2
    est.add(9.9, 40.0, 24.0, rf_on=True)  # next grid time is 10.0, not 10.3
    assert est.grid_samples == 2
    est.add(10.0, 40.0, 24.0, rf_on=True)
    assert est.grid_samples == 3


def test_a_tick_before_the_next_grid_time_adds_no_sample():
    est = PlantEstimator()
    est.add(0.0, 40.0, 24.0, rf_on=True)
    est.add(2.0, 40.0, 24.0, rf_on=True)
    assert est.grid_samples == 1


def test_grid_samples_is_read_only():
    est = PlantEstimator()
    with pytest.raises(AttributeError):
        est.grid_samples = 5  # type: ignore[misc]


def test_covariance_trace_is_capped_during_a_long_steady_hold():
    est = PlantEstimator()
    for n in range(int(7200 / 0.5)):  # 2 h dead-steady: the b direction is unexcited
        est.add(n * 0.5, 40.0, 24.0, rf_on=True)
    assert est._cov[0][0] + est._cov[1][1] <= 2 * COV_INIT + 1e-9


def _warm_start(k, tau, p, *, room=22.8, start=29.1, minutes=6, fix=..., noise=0.05, dt=0.5):
    """A part that starts warm (cooling toward ``room``) when RF comes on at constant ``p``.
    ``fix``: ... = the auto-latch, else the value passed to fix_ambient before the first tick."""
    rng = random.Random(1)
    est, temp, out = PlantEstimator(), start, None
    if fix is not ...:
        est.fix_ambient(fix)
    for n in range(int(minutes * 60 / dt)):
        temp += (k / tau * p - (temp - room) / tau) * dt
        out = est.add(n * dt, p, temp + rng.gauss(0, noise), rf_on=True)
    return out


def test_auto_latch_on_a_warm_part_underestimates_the_gain():
    # documents the 20261007_171928 failure mode: T_amb latched at 29.1, not the 22.8 room
    e = _warm_start(0.45, 180.0, 55.0)
    assert e.t_amb_c == pytest.approx(29.1, abs=0.3)
    assert e.valid and e.k_c_per_w < 0.85 * 0.45


def test_fixed_room_temperature_makes_a_warm_start_learn_what_a_cold_start_learns():
    e = _warm_start(0.45, 180.0, 55.0, fix=22.8)
    cold = _warm_start(0.45, 180.0, 55.0, start=22.8)  # at rest at room: the auto-latch is right
    assert e.t_amb_c == 22.8 and e.valid
    assert e.k_c_per_w == pytest.approx(0.45, rel=0.10)
    # tau is ~19 % long after 6 min at one constant power whether the start is warm or cold
    # (estimator limit at steady power); the fix's claim is warm == cold.
    assert e.k_c_per_w == pytest.approx(cold.k_c_per_w, rel=0.03)
    assert e.tau_s == pytest.approx(cold.tau_s, rel=0.03)


def test_fixed_unknown_room_temperature_never_learns():
    e = _warm_start(0.45, 180.0, 55.0, fix=None)
    assert e.t_amb_c is None and not e.valid and e.updates == 0


def test_reset_forgets_a_fixed_room_temperature():
    est = PlantEstimator()
    est.fix_ambient(None)
    est.reset()
    est.add(0.0, 30.0, 25.0, rf_on=True)
    assert est.estimate().t_amb_c == 25.0  # back to the auto-latch
