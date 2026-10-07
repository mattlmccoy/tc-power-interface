"""Cockpit API: status blocks, watch + run-mode endpoints, engage locked, and nothing actuates."""

import csv
import json
import time

from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app


def _client(tmp_path):
    return TestClient(
        create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path)
    )


def _wait_for(fn, timeout_s=1.0):
    """Poll ``fn`` until it returns truthy (or the timeout); return its last value."""
    deadline = time.monotonic() + timeout_s
    value = fn()
    while not value and time.monotonic() < deadline:
        time.sleep(0.05)
        value = fn()
    return value


def test_status_has_cockpit_blocks(tmp_path):
    with _client(tmp_path) as c:
        th = c.get("/api/status").json()["thermal"]
        assert th["watch"] == [] and th["run_mode"]["mode"] == "ladder"
        assert th["shadow"]["valid"] is False and th["shadow"]["why"] == "learning"
        reason = "core interlock not built yet (v0.18)"
        assert th["engage"] == {"available": False, "reason": reason}


def test_watch_endpoint_validates_and_persists(tmp_path):
    with _client(tmp_path) as c:
        ok = c.post("/api/thermal/watch", json={"names": ["toroid_C", "toroid_D"]})
        assert ok.status_code == 200
        too_many = c.post("/api/thermal/watch", json={"names": ["a", "b", "c", "d", "e"]})
        assert too_many.status_code == 422
    with _client(tmp_path) as c:  # survives an operator restart
        # The simulated source has no FLIR roster, so each name reports "not_in_feed" — but the
        # NAME is present once the observer has ticked.
        watch = _wait_for(lambda: c.get("/api/status").json()["thermal"]["watch"])
        assert [w["name"] for w in watch] == ["toroid_C", "toroid_D"]


def test_run_mode_endpoint(tmp_path):
    with _client(tmp_path) as c:
        r = c.post("/api/run-mode", json={"mode": "ladder", "ladder_w": [10, 5]})
        assert r.status_code == 200 and r.json()["ladder_w"] == [5, 10]
        assert c.get("/api/run-mode").json()["ladder_w"] == [5, 10]
        assert c.post("/api/run-mode", json={"mode": "angle"}).status_code == 422


def test_engage_is_locked(tmp_path):
    with _client(tmp_path) as c:
        r = c.post("/api/thermal/engage")
        assert r.status_code == 409 and "interlock" in r.json()["detail"]


def test_cockpit_never_commands_power(tmp_path):
    with _client(tmp_path) as c:
        calls = []
        ctrl = c.app.state.controller
        real = ctrl.set_setpoint
        ctrl.set_setpoint = lambda w: calls.append(w) or real(w)
        c.post("/api/run-mode", json={"mode": "target"})
        c.post("/api/thermal/watch", json={"names": ["toroid_C"]})
        c.post("/api/rf/enable")
        time.sleep(0.8)  # ~16 ticks with RF on: the observer runs every tick
        c.post("/api/rf/disable")
        assert calls == []


def test_recording_carries_cockpit_columns_and_roi_sidecar(tmp_path):
    with _client(tmp_path) as c:
        c.post("/api/run-mode", json={"mode": "fixed", "fixed_w": 20})
        c.post("/api/rf/enable")  # auto-log starts a recording on the RF-on edge
        run = _wait_for(lambda: c.get("/api/recording/status").json()["run"])
        assert run
        time.sleep(0.5)
        c.post("/api/rf/disable")
        c.post("/api/recording/stop")
    run_dir = tmp_path / run
    with (run_dir / "telemetry.csv").open() as f:
        rows = list(csv.DictReader(f))
    assert rows and "setpoint_w" in rows[0]
    assert all(r["run_mode"] == "fixed" for r in rows[1:])  # row 0 may precede the first observe
    # The simulated source has no FLIR roster, so the sidecar is header-only — it must still exist.
    assert (run_dir / "roi_temps.csv").is_file()


def test_save_source_from_roi_endpoint_keeps_watch(tmp_path):
    with _client(tmp_path) as c:
        c.post("/api/thermal/watch", json={"names": ["toroid_C"]})
        c.post("/api/thermal/roi", json={"name": "part"})
    with _client(tmp_path) as c:
        watch = _wait_for(lambda: c.get("/api/status").json()["thermal"]["watch"])
        assert [w["name"] for w in watch] == ["toroid_C"]
        assert c.get("/api/status").json()["thermal"]["control_roi"] == "part"


def test_run_mode_load_is_clamped_to_the_real_limit(tmp_path):
    (tmp_path / ".run_mode.json").write_text(json.dumps({"mode": "ladder", "ladder_w": [5, 9999]}))
    with _client(tmp_path) as c:
        status = c.get("/api/status").json()
        limit = c.app.state.controller.limits.max_forward_w
        assert max(status["thermal"]["run_mode"]["ladder_w"]) <= limit


def test_observer_failure_never_breaks_the_thermal_tick(tmp_path):
    class _Poster:  # stands in for the FLIR control-telemetry poster
        enabled = True

        def __init__(self):
            self.bodies = []

        def post(self, body):
            self.bodies.append(body)

    def _boom(**_kw):
        raise RuntimeError("observer bug")

    with _client(tmp_path) as c:
        poster = _Poster()
        c.app.state.control_telemetry = poster
        c.app.state.cockpit.observe = _boom
        # The rest of the tick (here: the 1 s power heartbeat to FLIR) still runs.
        assert _wait_for(lambda: poster.bodies, timeout_s=2.0)
