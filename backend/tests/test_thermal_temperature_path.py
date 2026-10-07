"""The FLIR temperature path, end to end (2026-10-06 root cause).

TC-POWER recorded ``thermal_control_temp_c == 0.0`` in 43 of 45 runs because (1) the loop's
temperature
was only read while the loop was RUNNING and otherwise kept its initial 0.0, which the recorder
logged on
every sample; (2) an invalid reading also stored 0.0; (3) the source defaulted to the SIMULATED
source on
the real generator; (4) the FLIR source asked for a hard-coded ROI name (``circle_medium_small``)
that the
redrawn FLIR sessions no longer have, and the choice reset on every restart. Unknown must never
read as a
temperature (data-contract rule 5).
"""

from fastapi.testclient import TestClient
from test_flir_roi_temps import _LIVE_A70_HEALTHY, _LIVE_NOT_ACQUIRING  # captured real payloads

from tc_power_interface.api.app import create_app
from tc_power_interface.control.safety import SafetyLimits
from tc_power_interface.control.temperature import TemperatureSample
from tc_power_interface.control.thermal_loop import ThermalController, ThermalPlan
from tc_power_interface.control.thermal_store import load_source, save_source
from tc_power_interface.integration.control_telemetry import build_control_telemetry
from tc_power_interface.integration.flir_roi_temps import FlirPollingSource


class _Fake:
    backend = "serial"

    def __init__(self, rf_on=True):
        self._rf_on = rf_on
        self.last_setpoint = None
        self.limits = SafetyLimits(max_forward_w=350)

    def set_setpoint(self, w):
        self.last_setpoint = w
        return w

    def snapshot(self):
        return {
            "state": "connected",
            "telemetry": {"rf_on": self._rf_on, "forward_w": 40.0, "load_w": 39.0},
        }


class _Fixed:
    def __init__(self, c, valid=True):
        self.c, self.valid = c, valid

    def read(self):
        return TemperatureSample(celsius=self.c, valid=self.valid, ts=0.0)


def test_unknown_temperature_is_none_never_zero():
    tc = ThermalController(_Fake(), _Fixed(0.0, valid=False), plan=ThermalPlan())
    assert tc.snapshot()["control_temp_c"] is None  # before any reading
    tc.start()
    tc.tick(0.1)
    snap = tc.snapshot()
    assert snap["control_temp_c"] is None  # an invalid reading is not 0 C
    assert snap["recommended_w"] == 0.0


def test_temperature_is_observed_while_the_loop_is_stopped():
    fake = _Fake()
    tc = ThermalController(fake, _Fixed(42.5), plan=ThermalPlan(), mode="auto")
    tc.tick(0.1)  # loop never started: observe only
    snap = tc.snapshot()
    assert snap["control_temp_c"] == 42.5
    assert snap["recommended_w"] == 0.0
    assert fake.last_setpoint is None  # observing never commands power


def test_control_telemetry_carries_no_number_for_an_unknown_temperature():
    body = build_control_telemetry(
        thermal={"target_c": 185.0, "control_temp_c": None, "phase": "ramp", "mode": "advisory"},
        telemetry={"forward_w": 40.0}, roi="freehand_sample", ts="t",
    )
    assert body["measured_c"] is None
    assert body["error_c"] is None


class _Get:
    def __init__(self, payloads):
        self.payloads = list(payloads)

    def __call__(self, url, timeout):
        p = self.payloads.pop(0) if len(self.payloads) > 1 else self.payloads[0]
        if isinstance(p, Exception):
            raise p
        return p


def test_flir_source_says_why_there_is_no_reading():
    src = FlirPollingSource("http://x", roi_name=None, _get=_Get([_LIVE_A70_HEALTHY]))
    src.poll_once()
    assert src.status == "no_roi_selected" and src.read().valid is False
    src.set_roi("freehand_sample")  # a name this (09-08) session does not have
    src.poll_once()
    assert src.status == "roi_not_in_feed"
    src.set_roi("front_electrode")
    src.poll_once()
    assert src.status == "ok" and src.read().valid is True
    nolive = FlirPollingSource(
        "http://x", roi_name="front_electrode", _get=_Get([_LIVE_NOT_ACQUIRING])
    )
    nolive.poll_once()
    assert nolive.status == "not_live"
    down = FlirPollingSource(
        "http://x", roi_name="front_electrode", _get=_Get([OSError("refused")])
    )
    down.poll_once()
    assert down.status == "no_feed"


def test_source_and_roi_choice_persist_with_no_invented_default(tmp_path):
    assert load_source(tmp_path, default_type="flir") == {"type": "flir", "roi": None, "watch": []}
    save_source(tmp_path, {"type": "flir", "roi": "freehand_sample"})
    expected = {"type": "flir", "roi": "freehand_sample", "watch": []}
    assert load_source(tmp_path, default_type="simulated") == expected


def test_api_has_no_hardcoded_roi_and_remembers_the_operators_choice(tmp_path):
    def client():
        return TestClient(
            create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path)
        )

    with client() as c:
        assert c.get("/api/thermal/rois").json()["control_roi"] is None
        c.post("/api/thermal/roi", json={"name": "freehand_sample"})
    with client() as c:  # an operator restart keeps the choice
        assert c.get("/api/thermal/rois").json()["control_roi"] == "freehand_sample"


def test_a_wrong_roi_is_reported_even_while_the_camera_is_off():
    # REAL captured payload: no camera, but the FLIR session's ROI roster is present.
    from test_flir_roi_temps import _LIVE_NO_CAMERA_ROSTER

    from tc_power_interface.integration.flir_roi_temps import control_status

    # fix the ROI first
    assert control_status(_LIVE_NO_CAMERA_ROSTER, "freehand_sample") == "roi_not_in_feed"
    # right ROI, camera off
    assert control_status(_LIVE_NO_CAMERA_ROSTER, "circle_medium_small") == "not_live"
    # no roster: can't tell
    assert control_status(_LIVE_NOT_ACQUIRING, "freehand_sample") == "not_live"
