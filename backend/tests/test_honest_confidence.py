"""Honest shadow confidence: the RLS fit confidence capped by how much K and tau moved in 2 min.

Real-data expectations come from captured fixtures (data-contract rule 3):
* run_20261007_165850_steady30w.json: ONE steady 30.5 W hold for 12.8 min, no step. The part kept
  heating along a slow second heat path, so K crept 0.42 -> 0.53 C/W and tau 176 -> 278 s while
  the fit confidence climbed to ~0.93 ("Good enough to compare").
* flir_20261002_125228_estimator.json: a 5 -> 70 W staircase.
"""

import json
import random
from pathlib import Path

from rest_prefix import rest_before_rf_on

from tc_power_interface.control.cockpit import (
    DRIFT_FULL,
    DRIFT_WINDOW_S,
    DRIFTING_ABOVE,
    UNKNOWN_DRIFT_FACTOR,
    CockpitObserver,
)
from tc_power_interface.control.run_mode import RunMode

FIXTURES = Path(__file__).parent / "fixtures"
STEADY = json.loads((FIXTURES / "run_20261007_165850_steady30w.json").read_text())
STAIR = json.loads((FIXTURES / "flir_20261002_125228_estimator.json").read_text())


def _feed(obs, t, power, temp, *, rf_on=True, target_c=185.0, ceiling_w=200.0):
    obs.observe(
        t_s=t,
        telemetry={"forward_w": power, "rf_on": rf_on},
        part_roi="freehand_sample",
        part_temp_c=temp,
        temp_status="ok",
        roi_temps=[],
        watch=[],
        run_id="run1",
        run_mode=RunMode(mode="target"),
        target_c=target_c,
        ceiling_w=ceiling_w,
    )


def _replay(fix, *, target_c):
    """Feed a fixture; return the observer and the shadow block after every grid sample."""
    obs, history = CockpitObserver(), []
    rest_before_rf_on(obs, fix["rois"]["freehand_sample"][0], t_on=fix["t_s"][0])
    rf = fix.get("rf_on") or [p >= 1 for p in fix["forward_w"]]
    for i, t in enumerate(fix["t_s"]):
        _feed(obs, t, fix["forward_w"][i], fix["rois"]["freehand_sample"][i], rf_on=rf[i],
              target_c=target_c)  # fmt: skip
        history.append((t, obs.snapshot()["shadow"]))
    return obs, history


def test_constants_are_the_documented_ones():
    assert DRIFT_WINDOW_S == 120.0 and DRIFT_FULL == 0.20 and DRIFTING_ABOVE == 0.05
    assert UNKNOWN_DRIFT_FACTOR == 0.5


def test_steady_run_reads_as_drifting_not_good_enough():
    obs, hist = _replay(STEADY, target_c=185.0)
    sh = obs.snapshot()["shadow"]
    # The raw RLS fit is as sure as it ever gets on this run ...
    assert sh["confidence_fit"] >= 0.9
    # ... but K/tau were still moving: honest confidence is far lower and says why.
    assert sh["drifting"] is True
    assert sh["drift_pct"] is not None and sh["drift_pct"] > 5.0
    assert sh["confidence"] <= 0.65  # measured 0.61: 7.8 % drift in the last 2 min (decelerating)
    assert sh["confidence_fit"] - sh["confidence"] >= 0.3
    # Through the middle of the hold K/tau moved 9.4-15.7 % per 2 min (measured): honest <= 0.55
    # (measured max 0.53) while the fit read 0.89-0.93.
    mid = [s for t, s in hist if 420.0 <= t <= 735.0]
    assert mid and all(s["confidence"] <= 0.55 and s["drifting"] for s in mid)
    assert all(s["confidence_fit"] >= 0.85 for s in mid)
    # The honest value is what the recorder writes.
    assert obs.record_fields()["shadow_conf"] == sh["confidence"]


def test_no_estimate_two_minutes_old_yet_caps_at_half_the_fit():
    _, hist = _replay(STEADY, target_c=185.0)
    first_valid = next(t for t, s in hist if s["valid"])
    early = [s for t, s in hist if s["valid"] and t < first_valid + DRIFT_WINDOW_S]
    assert early
    for s in early:
        assert s["drift_pct"] is None and s["drifting"] is False
        assert abs(s["confidence"] - UNKNOWN_DRIFT_FACTOR * s["confidence_fit"]) <= 1e-12


def test_invalid_estimate_reports_no_drift():
    _, hist = _replay(STEADY, target_c=185.0)
    s = hist[0][1]
    assert not s["valid"] and s["drift_pct"] is None and s["drifting"] is False
    assert s["confidence"] == 0.0 and s["confidence_fit"] == 0.0


def test_show_uses_the_honest_confidence():
    _, hist = _replay(STEADY, target_c=185.0)
    for _, s in hist:
        assert s["show"] == (s["valid"] and s["confidence"] >= 0.3)
    # At least once the fit alone would have shown the card but the honest value hides it.
    assert any(s["valid"] and s["confidence_fit"] >= 0.3 > s["confidence"] for _, s in hist)


def _first_order(profile, *, k=0.5, tau=150.0, t0=24.0, noise=0.05, dt=0.5, seed=0):
    rng, obs, temp = random.Random(seed), CockpitObserver(), t0
    rest_before_rf_on(obs, t0)  # the simulated part starts at rest at room temperature
    for n in range(int(profile[-1][0] / dt)):
        t = n * dt
        p = next(w for t_end, w in profile if t < t_end)
        temp += (k / tau * p - (temp - t0) / tau) * dt
        _feed(obs, t, p, temp + rng.gauss(0, noise), target_c=55.0)
    return obs.snapshot()["shadow"]


def test_a_true_first_order_plant_is_not_penalised_once_stable():
    sh = _first_order([(180, 20), (360, 40), (540, 60), (720, 40), (1000, 40)])
    assert sh["valid"] and sh["confidence_fit"] > 0.8
    assert sh["drift_pct"] is not None and sh["drift_pct"] < 2.0 and sh["drifting"] is False
    assert abs(sh["confidence"] - sh["confidence_fit"]) <= 0.1


def test_the_10_02_staircase_is_still_settling_at_its_end():
    """The 10-02 run's estimate went invalid during the staircase and only became valid again at
    t = 600 s (3.5 min before the end), mid-steps. Measured over the last 2 min: tau 318 -> 208 s
    and K 0.64 -> 0.53 C/W (drift 62 %), so the honest confidence is 0 there although the fit
    reads 0.76. The estimate was genuinely still settling, not converged."""
    obs, _ = _replay(STAIR, target_c=55.0)
    sh = obs.snapshot()["shadow"]
    assert 0.7 <= sh["confidence_fit"] <= 0.8
    assert sh["drifting"] is True and sh["drift_pct"] is not None and sh["drift_pct"] > 20.0
    assert sh["confidence"] < 0.3


# --- Fix 2: say WHY the suggestion is pinned at the ceiling -------------------------------------


def test_needed_power_and_ceiling_on_the_steady_run():
    obs, _ = _replay(STEADY, target_c=185.0)
    sh = obs.snapshot()["shadow"]
    assert sh["ceiling_w"] == 200.0
    assert sh["suggest_w"] == 200.0  # pinned at the ceiling, correctly
    want = (185.0 - sh["t_amb_c"]) / sh["k_c_per_w"]
    assert sh["needed_w"] is not None and abs(sh["needed_w"] - want) <= 1e-9
    assert 290.0 <= sh["needed_w"] <= 320.0  # 185 C from T_amb 22.8 at K 0.53 needs ~300 W


def test_needed_power_is_none_without_a_target_or_an_estimate():
    _, hist = _replay(STEADY, target_c=185.0)
    assert hist[0][1]["needed_w"] is None and hist[0][1]["ceiling_w"] == 200.0  # no estimate yet
    obs = CockpitObserver()
    rest_before_rf_on(obs, STEADY["rois"]["freehand_sample"][0], t_on=STEADY["t_s"][0])
    for i, t in enumerate(STEADY["t_s"]):
        obs.observe(
            t_s=t, telemetry={"forward_w": STEADY["forward_w"][i], "rf_on": STEADY["rf_on"][i]},
            part_roi="freehand_sample", part_temp_c=STEADY["rois"]["freehand_sample"][i],
            temp_status="ok", roi_temps=[], watch=[], run_id="r", run_mode=RunMode(mode="ladder"),
            target_c=185.0, ceiling_w=150.0,
        )  # fmt: skip
    sh = obs.snapshot()["shadow"]
    assert sh["valid"] and sh["needed_w"] is None and sh["ceiling_w"] == 150.0


def test_a_target_below_ambient_needs_no_power():
    obs, _ = _replay(STEADY, target_c=185.0)
    _feed(obs, STEADY["t_s"][-1] + 0.5, 30.0, 38.0, target_c=10.0)
    assert obs.snapshot()["shadow"]["needed_w"] == 0.0
