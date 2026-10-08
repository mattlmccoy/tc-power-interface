"""The cockpit decides the room temperature at RF on and never learns from a wrong one.

REAL data: run_20261007_171928_warm55w.json (55.5 W, began 8 min after run 165850 with the part
still cooling) and run_20261007_165850_steady30w.json (30.5 W, began at room temperature).
SYNTHETIC: the 70 s before RF on. Neither recording holds pre-RF readings (both start at RF on), so
the history is rebuilt from measured endpoints: run 2's part cooled toward the 22.8 C room with
tau ~214 s (fit of run 2's RF-off tail) and read 29.11 C at RF on, i.e. ~-1.8 C/min. Run 1 was at
rest at 22.83 C.
"""

import json
import math
from pathlib import Path

import pytest

from tc_power_interface.control.cockpit import CockpitObserver
from tc_power_interface.control.run_mode import RunMode

FIXTURES = Path(__file__).parent / "fixtures"
WARM = json.loads((FIXTURES / "run_20261007_171928_warm55w.json").read_text())
COLD = json.loads((FIXTURES / "run_20261007_165850_steady30w.json").read_text())
ROOM_C, COOL_TAU_S = 22.8, 214.0


def _tick(obs, t, temp, *, power=0.0, rf=False, run_id="run", rois=(), ambient_roi=None):
    obs.observe(
        t_s=t,
        telemetry={"forward_w": power, "rf_on": rf},
        part_roi="freehand_sample",
        part_temp_c=temp,
        temp_status="ok",
        roi_temps=[{"name": n, "mean_c": v, "valid": True} for n, v in rois],
        watch=[],
        run_id=run_id,
        run_mode=RunMode(mode="target"),
        target_c=185.0,
        ceiling_w=200.0,
        ambient_roi=ambient_roi,
    )


def _prefix(obs, at_rf_on_c, *, cooling, run_id="previous"):
    """70 s of RF-off readings (1 s apart) ending 1 s before RF on at t=0 (SYNTHETIC, see top)."""
    for t in range(-70, 0):
        temp = ROOM_C + (at_rf_on_c - ROOM_C) * math.exp(-t / COOL_TAU_S) if cooling else at_rf_on_c
        _tick(obs, float(t), temp, run_id=run_id)


def _replay(obs, fix, *, ambient_roi=None, run_id="run"):
    for i, t in enumerate(fix["t_s"]):
        rois = [(n, fix["rois"][n][i]) for n in fix["rois"]]
        _tick(obs, t, fix["rois"]["freehand_sample"][i], power=fix["forward_w"][i],
              rf=fix["rf_on"][i], run_id=run_id, rois=rois, ambient_roi=ambient_roi)


def test_warm_start_pauses_the_shadow_and_says_why():
    obs = CockpitObserver()
    _prefix(obs, WARM["rois"]["freehand_sample"][0], cooling=True)
    _replay(obs, WARM)
    sh = obs.snapshot()["shadow"]
    assert not sh["valid"] and sh["why"] == "room_unknown"
    assert sh["confidence"] == 0.0 and not sh["show"] and sh["needed_w"] is None
    amb = sh["ambient"]
    assert amb["t_c"] is None and amb["source"] is None and amb["reason"] == "part_cooling"
    # least-squares slope over the 60 s window: the exponential falls 31.15 -> 29.14 C, ~-2.04 C/min
    # (-1.8 C/min is the instantaneous rate at RF on)
    assert amb["slope_c_per_min"] == pytest.approx(-2.04, abs=0.1)
    r = obs.record_fields()
    assert r["shadow_amb_c"] is None and r["shadow_amb_src"] == "unknown:part_cooling"


def test_warm_start_with_a_reference_roi_learns_a_plausible_gain():
    # shunt_cap_FP is a REAL reading (23.44 C at RF on, ~0.6 C over the room: caps warm in runs too)
    obs = CockpitObserver()
    _prefix(obs, WARM["rois"]["freehand_sample"][0], cooling=True)
    _replay(obs, WARM, ambient_roi="shunt_cap_FP")
    sh = obs.snapshot()["shadow"]
    amb = sh["ambient"]
    assert amb["source"] == "reference" and amb["roi"] == "shunt_cap_FP"
    assert amb["t_c"] == pytest.approx(23.44, abs=0.01) and amb["reason"] == "part_cooling"
    # independent fits of the same physics: 0.43-0.51 C/W; the latched-at-29.1 bug gave 0.30
    assert sh["valid"] and 0.38 <= sh["k_c_per_w"] <= 0.55
    assert obs.record_fields()["shadow_amb_src"] == "reference"


def test_cold_start_at_rest_learns_as_before():
    obs = CockpitObserver()
    _prefix(obs, COLD["rois"]["freehand_sample"][0], cooling=False)
    _replay(obs, COLD)
    sh = obs.snapshot()["shadow"]
    assert sh["ambient"]["source"] == "part_at_rest" and sh["ambient"]["reason"] is None
    assert sh["ambient"]["t_c"] == pytest.approx(22.83, abs=0.01)
    assert sh["valid"] and sh["k_c_per_w"] == pytest.approx(0.53, abs=0.02)  # live value on 10-07
    assert obs.record_fields()["shadow_amb_src"] == "part_at_rest"


def test_no_reading_before_rf_on_is_unknown_not_rest():
    obs = CockpitObserver()
    _replay(obs, COLD)
    sh = obs.snapshot()["shadow"]
    assert not sh["valid"] and sh["why"] == "room_unknown"
    assert sh["ambient"]["reason"] == "no_history"


def test_history_survives_the_run_reset_at_rf_on():
    # the recorder starts a new run on the RF-on edge, so the history comes from the previous id
    obs = CockpitObserver()
    _prefix(obs, 22.83, cooling=False, run_id="previous")
    _tick(obs, 0.0, 22.83, power=30.0, rf=True, run_id="new")
    assert obs.snapshot()["shadow"]["ambient"]["source"] == "part_at_rest"


def test_room_temperature_is_decided_once_per_run():
    obs = CockpitObserver()
    _prefix(obs, 22.83, cooling=False)
    _tick(obs, 0.0, 22.83, power=30.0, rf=True)
    first = obs.snapshot()["shadow"]["ambient"]
    for t in range(1, 90):  # RF off and on again later in the same run: not re-judged
        _tick(obs, float(t), 30.0, power=0.0 if t < 80 else 30.0, rf=t >= 80)
    assert obs.snapshot()["shadow"]["ambient"] == first


def test_a_new_run_judges_again():
    obs = CockpitObserver()
    _tick(obs, 0.0, 22.83, power=30.0, rf=True, run_id="a")  # no history: unknown
    assert obs.snapshot()["shadow"]["ambient"]["reason"] == "no_history"
    for t in range(1, 80):
        _tick(obs, float(t), 22.83, run_id="a")  # RF off, part at rest
    _tick(obs, 80.0, 22.83, power=30.0, rf=True, run_id="b")
    assert obs.snapshot()["shadow"]["ambient"]["source"] == "part_at_rest"


def test_before_rf_on_there_is_no_decision_yet():
    obs = CockpitObserver()
    _prefix(obs, 22.83, cooling=False)
    sh = obs.snapshot()["shadow"]
    assert sh["ambient"] is None and sh["why"] == "learning"
    assert obs.record_fields()["shadow_amb_src"] is None


def test_rf_on_at_zero_power_is_not_heating():
    # RF enabled at a 0 W setpoint delivers nothing: it must not count as "RF was on recently"
    obs = CockpitObserver()
    for t in range(-70, 0):
        _tick(obs, float(t), 22.83, power=0.0, rf=True)
    _tick(obs, 0.0, 22.83, power=30.0, rf=True, run_id="run2")
    assert obs.snapshot()["shadow"]["ambient"]["source"] == "part_at_rest"


def test_an_unknown_room_is_judged_again_at_the_next_rf_on_in_the_same_run():
    # found on the simulator: a recording kept running across RF off, so the first (unknown)
    # decision stuck although the part then rested a full minute before RF came back
    obs = CockpitObserver()
    _tick(obs, 0.0, 25.0, power=20.0, rf=True)  # operator just started: no history
    assert obs.snapshot()["shadow"]["ambient"]["reason"] == "no_history"
    for t in range(1, 80):
        _tick(obs, float(t), 25.0)  # RF off, at rest, same run
    _tick(obs, 80.0, 25.0, power=20.0, rf=True)
    amb = obs.snapshot()["shadow"]["ambient"]
    assert amb["source"] == "part_at_rest" and amb["t_c"] == pytest.approx(25.0)
    assert obs.record_fields()["shadow_amb_src"] == "part_at_rest"


def test_an_unknown_room_is_not_rejudged_while_rf_stays_on():
    obs = CockpitObserver()
    _tick(obs, 0.0, 25.0, power=20.0, rf=True)
    for t in range(1, 80):  # RF stays on: no new RF-on edge, nothing to re-judge
        _tick(obs, float(t), 25.0, power=20.0, rf=True)
    assert obs.snapshot()["shadow"]["ambient"]["reason"] == "no_history"
