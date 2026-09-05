"""Tests for recording export (list + CSV download) and auto-log-on-RF-on."""

import time

from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app


def _client(tmp_path):
    return TestClient(
        create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path)
    )


def test_download_recording_csv_includes_loop_columns(tmp_path):
    with _client(tmp_path) as c:
        run = c.post("/api/recording/start", json={"name": "dl", "notes": ""}).json()["run"]
        c.post("/api/recording/stop")
        resp = c.get(f"/api/recordings/{run}/telemetry.csv")
        assert resp.status_code == 200
        assert "text/csv" in resp.headers["content-type"]
        assert "forward_w" in resp.text  # device power curve
        assert "thermal_recommended_w" in resp.text  # loop commanded curve


def test_download_missing_recording_is_404(tmp_path):
    with _client(tmp_path) as c:
        assert c.get("/api/recordings/nope/telemetry.csv").status_code == 404


def test_download_rejects_path_traversal(tmp_path):
    with _client(tmp_path) as c:
        assert c.get("/api/recordings/..%2f..%2fetc/telemetry.csv").status_code in (400, 404)


def test_list_recordings_newest_first(tmp_path):
    with _client(tmp_path) as c:
        c.post("/api/recording/start", json={"name": "one", "notes": ""})
        c.post("/api/recording/stop")
        runs = c.get("/api/recordings").json()["runs"]
        assert any("one" in r["run"] for r in runs)
        assert all("run" in r and "complete" in r for r in runs)


def test_auto_log_toggle(tmp_path):
    with _client(tmp_path) as c:
        assert c.get("/api/auto-log").json()["enabled"] is True  # on by default
        c.put("/api/auto-log", json={"enabled": False})
        assert c.get("/api/auto-log").json()["enabled"] is False


def test_auto_log_starts_recording_on_rf_on(tmp_path):
    with _client(tmp_path) as c:
        assert c.get("/api/recording/status").json()["active"] is False
        c.post("/api/rf/enable")  # operator enables RF -> loop should auto-start a recording
        active = False
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if c.get("/api/recording/status").json()["active"]:
                active = True
                break
            time.sleep(0.05)
        assert active
        assert "RF_" in c.get("/api/recording/status").json()["run"]


def test_auto_log_off_does_not_start(tmp_path):
    with _client(tmp_path) as c:
        c.put("/api/auto-log", json={"enabled": False})
        c.post("/api/rf/enable")
        time.sleep(0.4)
        assert c.get("/api/recording/status").json()["active"] is False
