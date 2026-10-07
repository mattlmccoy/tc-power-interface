"""Live first-order plant estimate (spec §3.2).

Real-data expectations come from the captured 10-02 run.
"""
import json
import random
from pathlib import Path

from tc_power_interface.control.plant_estimator import PlantEstimator

FIX = json.loads(
    (Path(__file__).parent / "fixtures/flir_20261002_125228_estimator.json").read_text()
)
SERIES = list(zip(FIX["t_s"], FIX["forward_w"], FIX["rois"]["freehand_sample"], strict=True))


def _simulate(k, tau, profile, noise, dt=0.5, t0=24.0, seed=0):
    """First-order plant dT/dt = (K/tau)P - (T-T0)/tau, sampled every dt with seeded noise."""
    rng = random.Random(seed)
    est, temp, out = PlantEstimator(), t0, None
    for n in range(int(profile[-1][0] / dt)):
        t = n * dt
        p = next(w for t_end, w in profile if t < t_end)
        temp += (k / tau * p - (temp - t0) / tau) * dt
        out = est.add(t, p, temp + rng.gauss(0, noise), rf_on=True)
    return out


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
