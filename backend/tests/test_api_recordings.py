"""Tests for recording export (list + CSV download) and auto-log-on-RF-on."""

import json
import threading
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


def _wait_active(c, want=True, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if c.get("/api/recording/status").json()["active"] is want:
            return True
        time.sleep(0.05)
    return False


def test_link_drop_stops_an_auto_started_recording(tmp_path):
    # 2026-10-06: run 20261006_164701 stayed open 14+ min with no rows after the generator died.
    with _client(tmp_path) as c:
        c.post("/api/rf/enable")
        assert _wait_active(c, True)
        run = c.get("/api/recording/status").json()["run"]
        c.app.state.controller.on_link_dropped()
        assert c.get("/api/recording/status").json() == {"active": False, "run": None}
        run_dir = tmp_path / run
        assert (run_dir / "manifest.json").exists()  # stopped cleanly: complete manifest
        labels = [e["label"] for e in json.loads((run_dir / "events.json").read_text())]
        assert "recording_stopped_link_lost" in labels
        assert labels.index("recording_stopped_link_lost") < labels.index("recording_stopped")


def test_link_drop_leaves_a_manual_recording_alone(tmp_path):
    with _client(tmp_path) as c:
        c.post("/api/recording/start", json={"name": "manual", "notes": ""})
        c.app.state.controller.on_link_dropped()
        assert c.get("/api/recording/status").json()["active"] is True


def test_manual_recording_after_an_auto_run_is_left_alone(tmp_path):
    with _client(tmp_path) as c:
        c.post("/api/rf/enable")
        assert _wait_active(c, True)
        c.post("/api/recording/stop")
        assert _wait_active(c, False)
        c.post("/api/recording/start", json={"name": "manual", "notes": ""})
        c.app.state.controller.on_link_dropped()
        assert c.get("/api/recording/status").json()["active"] is True


def test_concurrent_stops_finalize_exactly_once(tmp_path):
    # The poll thread (link drop) and an HTTP thread (operator Stop) can stop at the same moment.
    from tc_power_interface.recording.recorder import TelemetryRecorder

    rec = TelemetryRecorder(tmp_path)
    run_dir = rec.start("race", {})
    real_event = rec.event

    def _slow_event(label, data=None):  # widen the check-then-act window: reproducible race
        real_event(label, data)
        if label == "recording_stopped":
            time.sleep(0.05)

    rec.event = _slow_event
    barrier = threading.Barrier(8)
    results = []

    def _stop():
        barrier.wait()
        results.append(rec.stop())

    threads = [threading.Thread(target=_stop) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert [r for r in results if r is not None] == [run_dir]  # exactly one finalizer
    events = json.loads((run_dir / "events.json").read_text())
    assert [e["label"] for e in events].count("recording_stopped") == 1
