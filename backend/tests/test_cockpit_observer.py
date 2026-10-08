"""The observer composes estimator, shadow and core watch; resets per recording; cannot actuate."""

import inspect
import json
from pathlib import Path

from tc_power_interface.control import cockpit
from tc_power_interface.control.cockpit import CockpitObserver
from tc_power_interface.control.run_mode import RunMode

from rest_prefix import rest_before_rf_on

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
    rest_before_rf_on(obs, FIX["rois"]["freehand_sample"][0], t_on=FIX["t_s"][0])
    for i, t in enumerate(FIX["t_s"]):
        _feed(obs, t, i, run_id=run_id, mode=mode, part_temp=part_temp)


def test_real_run_snapshot_and_record_fields():
    obs = CockpitObserver()
    _replay(obs)
    s = obs.snapshot()
    sh = s["shadow"]
    assert 0.35 <= sh["k_c_per_w"] <= 0.65 and sh["valid"] and sh["confidence_fit"] >= 0.5
    # Honest confidence (fit capped by 2-min drift) is 0 here: measured over the run's last 2 min,
    # tau 318 -> 208 s and K 0.64 -> 0.53 C/W (62 % drift); the estimate was still settling.
    assert sh["drifting"] and sh["confidence"] < 0.3 and not sh["show"]
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
    assert not sh["valid"] and sh["k_c_per_w"] is None
    # run2 starts hot with no rest minute before it: the room temperature is unknown, not "learning"
    assert sh["why"] == "room_unknown" and sh["ambient"]["reason"] == "no_history"


def test_shadow_steps_once_per_grid_sample_not_per_tick():
    coarse = CockpitObserver()
    _replay(coarse)
    fine = CockpitObserver()
    rest_before_rf_on(fine, FIX["rois"]["freehand_sample"][0], t_on=FIX["t_s"][0])
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


def _tick(obs, t, *, power, temp, rf_on=True, mode="target", target_c=55.0, run_id="run1"):
    obs.observe(
        t_s=t,
        telemetry={"forward_w": power, "rf_on": rf_on},
        part_roi="freehand_sample",
        part_temp_c=temp,
        temp_status="ok",
        roi_temps=[],
        watch=[],
        run_id=run_id,
        run_mode=RunMode(mode=mode),
        target_c=target_c,
        ceiling_w=200.0,
    )


def _after_fixture() -> tuple[CockpitObserver, float, float, float]:
    obs = CockpitObserver()
    _replay(obs)
    return obs, FIX["t_s"][-1], FIX["forward_w"][-1], FIX["rois"]["freehand_sample"][-1]


def test_missing_or_nonfinite_power_counts_as_zero_watts():
    for bad in (None, float("nan"), float("inf")):
        obs, t, _, temp = _after_fixture()
        _tick(obs, t + 0.5, power=bad, temp=temp)
        sh = obs.snapshot()["shadow"]
        assert sh["valid"]
        assert sh["plateau_c"] == sh["t_amb_c"]  # 0 W -> plateau is ambient
    obs, t, _, temp = _after_fixture()
    obs.observe(  # forward_w key absent altogether
        t_s=t + 0.5, telemetry={"rf_on": True}, part_roi="r", part_temp_c=temp, temp_status="ok",
        roi_temps=[], watch=[], run_id="run1", run_mode=RunMode(mode="target"),
        target_c=55.0, ceiling_w=200.0,
    )  # fmt: skip
    sh = obs.snapshot()["shadow"]
    assert sh["plateau_c"] == sh["t_amb_c"]


def test_rf_off_forces_zero_power_even_if_forward_reading_is_nonzero():
    obs, t, _, temp = _after_fixture()
    _tick(obs, t + 0.5, power=6.0, temp=temp, rf_on=False)  # reflected/leak reading with RF off
    sh = obs.snapshot()["shadow"]
    assert sh["plateau_c"] == sh["t_amb_c"]


def test_unknown_temperature_clears_a_standing_suggestion_on_the_same_tick():
    obs, t, p, temp = _after_fixture()
    assert obs.snapshot()["shadow"]["suggest_w"] is not None
    _tick(obs, t + 0.5, power=p, temp=None)  # mid-grid: not a new grid sample
    assert obs.snapshot()["shadow"]["suggest_w"] is None
    assert obs.record_fields()["shadow_suggest_w"] is None
    _tick(obs, t + 1.0, power=p, temp=float("nan"))
    assert obs.snapshot()["shadow"]["suggest_w"] is None


def test_mode_switch_restarts_the_shadow_bumplessly_from_the_operators_power():
    obs, t, p, temp = _after_fixture()
    for k in range(1, 16):  # 15 grid samples in ladder mode, target_c not meaningful there
        _tick(obs, t + 5.0 * k, power=p, temp=temp, mode="ladder", target_c=0.0)
    assert obs.snapshot()["shadow"]["suggest_w"] is None
    _tick(obs, t + 5.0 * 16, power=p, temp=temp, mode="target", target_c=300.0)
    s = obs.snapshot()["shadow"]["suggest_w"]
    assert s is not None and abs(s - p) <= 10.0  # MAX_STEP_W from the operator's power


def test_estimator_keeps_running_in_ladder_mode():
    obs = CockpitObserver()
    _replay(obs, mode="ladder")
    sh = obs.snapshot()["shadow"]
    assert sh["valid"] and 0.35 <= sh["k_c_per_w"] <= 0.65


def test_flat_temperature_reports_no_consistent_fit():
    obs = CockpitObserver()
    rest_before_rf_on(obs, 25.0)
    for k in range(40):
        _tick(obs, 5.0 * k, power=50.0, temp=25.0)
    sh = obs.snapshot()["shadow"]
    assert not sh["valid"] and sh["why"] == "no consistent first-order fit yet"
    assert sh["updates"] >= 6


def test_record_fields_in_ladder_mode_with_a_valid_estimate():
    obs = CockpitObserver()
    _replay(obs, mode="ladder")
    r = obs.record_fields()
    assert r["target_c"] is None and r["shadow_suggest_w"] is None
    assert r["shadow_k"] is not None and r["run_mode"] == "ladder"


def test_cannot_actuate_by_construction():
    params = inspect.signature(CockpitObserver.__init__).parameters
    assert set(params) == {"self"}  # no controller is ever handed in
    src = inspect.getsource(cockpit)
    for forbidden in ("set_setpoint", "enable_rf", "set_tune", "set_load"):
        assert forbidden not in src


def test_grid_samples_counts_the_estimators_real_grid_samples():
    obs = CockpitObserver()
    assert obs.grid_samples == 0
    _feed(obs, 0.0, 0)
    _feed(obs, 0.5, 0)  # inside the same 5 s grid step: no new sample
    assert obs.grid_samples == 1
    _feed(obs, 5.0, 1)
    assert obs.grid_samples == 2


def test_unknown_power_is_none_not_zero_watts():
    """The idle observer (no generator) does not know the power. It must not be shown as 0 W: no
    plateau / settle / time-to-target / suggestion from it, while the fit itself is kept."""
    obs, t, _, temp = _after_fixture()
    before = obs.snapshot()["shadow"]
    assert before["plateau_c"] is not None and before["settle_s"] is not None
    obs.observe(
        t_s=t + 0.5, telemetry={}, part_roi="freehand_sample", part_temp_c=temp,
        temp_status="ok", roi_temps=[], watch=[], run_id="run1", run_mode=RunMode(mode="target"),
        target_c=55.0, ceiling_w=200.0, power_known=False,
    )  # fmt: skip
    sh = obs.snapshot()["shadow"]
    assert sh["plateau_c"] is None and sh["settle_s"] is None and sh["ttt_s"] is None
    assert sh["suggest_w"] is None
    assert sh["valid"] == before["valid"] and sh["why"] == before["why"]
