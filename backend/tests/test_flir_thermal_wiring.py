"""API-level wiring for the FLIR closed-loop thermal integration (locked contract 2026-09-08).

Verifies the two behaviours the unit tests can't: the live temperature consumer is actually STARTED
when the source is set to flir (the gap where it was defined but never started), and a running
thermal loop POSTs control telemetry when the FLIR link is enabled. Network/threads are avoided by
stubbing the polling source and the poster's HTTP.
"""

from fastapi.testclient import TestClient

import tc_power_interface.api.app as app_module
from tc_power_interface.api.app import create_app


def _client(tmp_path):
    return TestClient(
        create_app(backend="simulated", poll_interval_s=0.02, experiments_root=tmp_path)
    )


class _StubSource:
    """Stands in for FlirPollingSource: records construction + start(), no thread/network."""

    instances: list["_StubSource"] = []

    def __init__(self, url, *, roi_name="circle_medium_small"):
        self.url = url
        self.roi_name = roi_name
        self.started = False
        _StubSource.instances.append(self)

    def start(self):
        self.started = True

    def stop(self):
        self.started = False

    def available_rois(self):
        return ["part_center", "circle_medium_small", "hotspot"]

    def set_roi(self, name):
        self.roi_name = name

    def read(self):  # pragma: no cover - not exercised here
        from tc_power_interface.control.temperature import TemperatureSample

        return TemperatureSample(celsius=0.0, valid=False, ts=0.0)


def test_setting_source_to_flir_starts_the_polling_consumer(tmp_path, monkeypatch):
    _StubSource.instances.clear()
    monkeypatch.setattr(app_module, "FlirPollingSource", _StubSource)
    with _client(tmp_path) as c:
        r = c.post("/api/thermal/source", json={"type": "flir", "url": "http://127.0.0.1:8000"})
        assert r.status_code == 200
        assert r.json()["source"] == "flir"
        assert len(_StubSource.instances) == 1
        src = _StubSource.instances[0]
        assert src.started is True  # the consumer is actually running (was the gap)
        assert src.url == "http://127.0.0.1:8000/api/live/roi-temps"  # base -> roi-temps endpoint
        assert src.roi_name == "circle_medium_small"


def test_control_roi_is_selectable_from_the_live_roster(tmp_path, monkeypatch):
    _StubSource.instances.clear()
    monkeypatch.setattr(app_module, "FlirPollingSource", _StubSource)
    with _client(tmp_path) as c:
        c.post("/api/thermal/source", json={"type": "flir", "url": "http://127.0.0.1:8000"})
        rois = c.get("/api/thermal/rois").json()
        assert rois["available_rois"] == ["part_center", "circle_medium_small", "hotspot"]
        assert rois["control_roi"] == "circle_medium_small"  # default, but not fixed
        # The operator selects a different live ROI (ROIs change print-to-print).
        r = c.post("/api/thermal/roi", json={"name": "part_center"})
        assert r.status_code == 200
        assert r.json()["control_roi"] == "part_center"
        assert c.app.state.thermal.source.roi_name == "part_center"  # switched on the live source
        # The selection flows into the posted control telemetry's roi field.
        posted: list[dict] = []
        poster = c.app.state.control_telemetry
        poster._post = lambda url, body, timeout: posted.append(body)
        poster.enabled = True
        poster.url = "http://127.0.0.1:8000"
        c.post("/api/thermal/start", json={"mode": "auto"})
        c.app.state.controller._tick()
        poster.join()
        assert posted[-1]["roi"] == "part_center"


def test_flir_link_enables_the_control_telemetry_poster(tmp_path):
    with _client(tmp_path) as c:
        c.post("/api/flir-link", json={"url": "http://127.0.0.1:8000", "enabled": True})
        poster = c.app.state.control_telemetry
        assert poster.enabled is True
        assert poster.url == "http://127.0.0.1:8000"


def test_running_thermal_loop_posts_control_telemetry(tmp_path):
    with _client(tmp_path) as c:
        posted: list[dict] = []
        poster = c.app.state.control_telemetry
        poster._post = lambda url, body, timeout: posted.append(body)
        poster.enabled = True
        poster.url = "http://127.0.0.1:8000"
        c.post("/api/thermal/start", json={"mode": "auto"})
        c.app.state.controller._tick()  # one poll -> thermal tick -> control-telemetry POST
        poster.join()
        assert posted, "a running thermal loop should POST control telemetry each tick"
        body = posted[-1]
        assert body["roi"] == "circle_medium_small"
        assert "setpoint_c" in body and "measured_c" in body and "error_c" in body


def test_no_control_telemetry_when_link_disabled(tmp_path):
    with _client(tmp_path) as c:
        posted: list[dict] = []
        poster = c.app.state.control_telemetry
        poster._post = lambda url, body, timeout: posted.append(body)
        poster.enabled = False  # link off -> no outbound POSTs
        c.post("/api/thermal/start", json={"mode": "auto"})
        c.app.state.controller._tick()
        poster.join()
        assert posted == []
