"""The operator's room reference ROI: persisted like the control ROI, reported in status, and handed
to the cockpit, which uses it when the part was not seen at rest before RF on."""

from test_api_idle_observer import _MEAN, _client, _flir_stub, _wait_for


def _thermal(c):
    return c.get("/api/status").json()["thermal"]


def test_room_reference_endpoint_persists_and_is_reported(tmp_path):
    with _client(tmp_path, "simulated") as c:
        r = c.post("/api/thermal/ambient", json={"name": "toroid_D"})
        assert r.status_code == 200 and r.json()["ambient_roi"] == "toroid_D"
        assert c.get("/api/thermal/rois").json()["ambient_roi"] == "toroid_D"
        assert _thermal(c)["ambient_roi"] == "toroid_D"
        c.post("/api/thermal/roi", json={"name": "freehand_sample"})  # other saves keep it
        c.post("/api/thermal/watch", json={"names": ["toroid_C"]})
    with _client(tmp_path, "simulated") as c:  # survives an operator restart
        assert _thermal(c)["ambient_roi"] == "toroid_D"
        assert c.post("/api/thermal/ambient", json={"name": ""}).json()["ambient_roi"] is None
    with _client(tmp_path, "simulated") as c:
        assert _thermal(c)["ambient_roi"] is None


def test_rf_on_with_no_rest_minute_takes_the_reference_reading(tmp_path):
    with _client(tmp_path, "simulated") as c:
        c.app.state.thermal.source = _flir_stub()
        c.post("/api/thermal/roi", json={"name": "freehand_sample"})
        c.post("/api/thermal/ambient", json={"name": "toroid_D"})
        c.post("/api/setpoint", json={"watts": 5})
        c.post("/api/rf/enable")  # seconds after start: no minute of history yet
        amb = _wait_for(lambda: _thermal(c)["shadow"]["ambient"], timeout_s=3.0)
        c.post("/api/rf/disable")
    assert amb, "the cockpit never decided a room temperature with RF on"
    assert amb["source"] == "reference" and amb["roi"] == "toroid_D"
    assert amb["t_c"] == _MEAN["toroid_D"] and amb["reason"] == "no_history"
