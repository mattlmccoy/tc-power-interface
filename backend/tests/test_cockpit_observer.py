"""The observer composes estimator, shadow and core watch; resets per recording; cannot actuate."""

import inspect
import json
from pathlib import Path

from tc_power_interface.control import cockpit
from tc_power_interface.control.cockpit import CockpitObserver
from tc_power_interface.control.run_mode import RunMode

FIX = json.loads(
    (Path(__file__).parent / "fixtures/flir_20261002_125228_estimator.json").read_text()
)


def _feed(obs, t, i, *, run_id="run1", mode="target", part_temp="fixture"):
    p = FIX["forward_w"][i]
    rois = [{"name": n, "mean_c": FIX["rois"][n][i], "valid": True} for n in FIX["rois"]]
    part = FIX["rois"]["freehand_sample"][i] if part_temp == "fixture" else part_temp
    obs.observe(
        t_s=t,
        telemetry={"forward_w": p, "rf_on": p >= 1},
        part_roi="freehand_sample",
        part_temp_c=part,
        temp_status="ok",
        roi_temps=rois,
        watch=["toroid_C"],
        run_id=run_id,
        run_mode=RunMode(mode=mode),
        target_c=55.0,
        ceiling_w=200.0,
    )


def _replay(obs, run_id="run1", mode="target", part_temp="fixture"):
    for i, t in enumerate(FIX["t_s"]):
        _feed(obs, t, i, run_id=run_id, mode=mode, part_temp=part_temp)


def test_real_run_snapshot_and_record_fields():
    obs = CockpitObserver()
    _replay(obs)
    s = obs.snapshot()
    sh = s["shadow"]
    print("END", sh["suggest_w"], sh["confidence"], sh["k_c_per_w"])
    assert 0.35 <= sh["k_c_per_w"] <= 0.65 and sh["valid"] and sh["confidence"] >= 0.5
    assert 50 <= sh["suggest_w"] <= 75  # to-temperature mode shows a suggestion
    assert sh["plateau_c"] is not None and sh["settle_s"] is not None
    assert s["watch"][0]["name"] == "toroid_C" and s["watch"][0]["rate_c_per_min"] is not None
    r = obs.record_fields()
    assert (
        r["part_roi"] == "freehand_sample" and r["run_mode"] == "target" and r["target_c"] == 55.0
    )
    assert r["shadow_suggest_w"] == sh["suggest_w"]


def test_no_suggestion_outside_to_temperature_mode_but_plateau_still_shown():
    obs = CockpitObserver()
    _replay(obs, mode="ladder")
    sh = obs.snapshot()["shadow"]
    assert sh["suggest_w"] is None and sh["plateau_c"] is not None
    assert obs.record_fields()["target_c"] is None  # no target outside to-temperature mode


def test_a_new_recording_resets_the_estimate():
    obs = CockpitObserver()
    _replay(obs, run_id="run1")
    obs.observe(
        t_s=10_000.0,
        telemetry={"forward_w": 40.0, "rf_on": True},
        part_roi="freehand_sample",
        part_temp_c=30.0,
        temp_status="ok",
        roi_temps=[],
        watch=[],
        run_id="run2",
        run_mode=RunMode(mode="target"),
        target_c=55.0,
        ceiling_w=200.0,
    )
    sh = obs.snapshot()["shadow"]
    assert not sh["valid"] and sh["k_c_per_w"] is None and sh["why"] == "learning"


def test_shadow_steps_once_per_grid_sample_not_per_tick():
    coarse = CockpitObserver()
    _replay(coarse)
    fine = CockpitObserver()
    for i, t in enumerate(FIX["t_s"]):
        for k in range(10):  # hold each 5 s sample constant over ten 0.5 s ticks
            _feed(fine, t + 0.5 * k, i)
    a = coarse.snapshot()["shadow"]["suggest_w"]
    b = fine.snapshot()["shadow"]["suggest_w"]
    assert a is not None and b is not None
    assert abs(a - b) <= 0.5


def test_unknown_part_temperature_is_none_in_record_fields():
    obs = CockpitObserver()
    _replay(obs, part_temp=None)
    r = obs.record_fields()
    assert r["part_temp_c"] is None
    assert r["shadow_suggest_w"] is None
    assert obs.snapshot()["shadow"]["suggest_w"] is None


def test_returning_to_no_recording_does_not_reset():
    obs = CockpitObserver()
    _replay(obs, run_id="run1")
    before = obs.snapshot()["shadow"]["k_c_per_w"]
    assert before is not None
    obs.observe(
        t_s=FIX["t_s"][-1] + 5.0,
        telemetry={"forward_w": 40.0, "rf_on": True},
        part_roi="freehand_sample",
        part_temp_c=40.0,
        temp_status="ok",
        roi_temps=[],
        watch=[],
        run_id=None,
        run_mode=RunMode(mode="target"),
        target_c=55.0,
        ceiling_w=200.0,
    )
    assert obs.snapshot()["shadow"]["valid"]


def test_missing_or_nonfinite_power_is_treated_as_zero():
    obs = CockpitObserver()
    for tel in ({"rf_on": False}, {"forward_w": None, "rf_on": False}, {"forward_w": float("nan")}):
        obs.observe(
            t_s=0.0,
            telemetry=tel,
            part_roi="r",
            part_temp_c=25.0,
            temp_status="ok",
            roi_temps=[],
            watch=[],
            run_id="x",
            run_mode=RunMode(mode="target"),
            target_c=55.0,
            ceiling_w=200.0,
        )
    assert obs.snapshot()["shadow"]["valid"] is False


def test_cannot_actuate_by_construction():
    params = inspect.signature(CockpitObserver.__init__).parameters
    assert set(params) == {"self"}  # no controller is ever handed in
    src = inspect.getsource(cockpit)
    for forbidden in ("set_setpoint", "enable_rf", "set_tune", "set_load"):
        assert forbidden not in src
