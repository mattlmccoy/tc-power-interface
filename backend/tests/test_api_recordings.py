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


def test_single_0xffff_status_frame_starts_no_phantom_recording(tmp_path):
    """2026-10-07: one 0xFFFF GS word (RF_ENABLED + every alarm bit set) auto-started an RF_*
    recording for a phantom RF-on and latched a FAULT. Injected through the real simulated
    transport + CxnDevice + codec, it must start nothing and leave the controller CONNECTED."""
    with _client(tmp_path) as c:
        controller = c.app.state.controller
        transport = controller.device.transport
        real_word = transport._status_word
        served = {"n": 0}

        def one_garbled_word() -> int:
            served["n"] += 1
            return 0xFFFF if served["n"] == 1 else real_word()

        transport._status_word = one_garbled_word
        deadline = time.monotonic() + 3
        while served["n"] < 6 and time.monotonic() < deadline:  # the glitch + several good polls
            time.sleep(0.05)
        assert served["n"] >= 6
        status = c.get("/api/recording/status").json()
        assert status["active"] is False
        assert controller.state.value == "connected"
        assert controller.fault_reasons == ()
