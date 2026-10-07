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


def _wait_idle(c, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if c.get("/api/recording/status").json() == {"active": False, "run": None}:
            return True
        time.sleep(0.05)
    return False


def _slow_first_write(rec, delay_s=0.4):
    """Make the writer thread's first row write slow (a Dropbox stall) so a stop() has a drain."""
    real = rec._write_row
    state = {"slow": True}
    started = threading.Event()  # set once the slow write is in progress (deterministic drain)

    def _slow(row):
        if state["slow"]:
            state["slow"] = False
            started.set()
            time.sleep(delay_s)
        real(row)

    rec._write_row = _slow
    return started


def _wait_state(rec, want, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if rec.state is want:
            return True
        time.sleep(0.005)
    return False


_SNAP = {"state": "armed", "telemetry": {"host_timestamp_ns": 1, "forward_w": 1.0}}


def test_start_during_a_stops_drain_is_refused_and_the_run_gets_its_manifest(tmp_path):
    import pytest

    from tc_power_interface.recording.recorder import RecorderState, TelemetryRecorder

    rec = TelemetryRecorder(tmp_path)
    _slow_first_write(rec)
    run_dir = rec.start("a", {})
    rec.record(_SNAP)
    stopper = threading.Thread(target=rec.stop)
    stopper.start()
    assert _wait_state(rec, RecorderState.STOPPING)
    with pytest.raises(RuntimeError, match="busy"):
        rec.start("b", {})  # must not clobber the files the drain is still writing
    stopper.join()
    manifest = json.loads((run_dir / "manifest.json").read_text())
    assert manifest["complete"] is True and manifest["sample_count"] == 1
    assert rec.state is RecorderState.IDLE
    second = rec.start("c", {})  # after the stop completes a new run is fine
    assert second != run_dir
    rec.stop()
    assert (second / "manifest.json").exists()


def test_api_start_during_a_stops_drain_is_409(tmp_path):
    from tc_power_interface.recording.recorder import RecorderState

    with _client(tmp_path) as c:
        rec = c.app.state.recorder
        c.post("/api/recording/start", json={"name": "one", "notes": ""})
        time.sleep(0.2)  # let a row be queued
        assert _slow_first_write(rec, 0.6).wait(3.0)
        stopper = threading.Thread(target=lambda: c.post("/api/recording/stop"))
        stopper.start()
        assert _wait_state(rec, RecorderState.STOPPING)
        assert c.get("/api/recording/status").json()["active"] is False  # stopping is not active
        resp = c.post("/api/recording/start", json={"name": "two", "notes": ""})
        assert resp.status_code == 409
        stopper.join()


def test_stop_if_current_only_stops_the_named_run(tmp_path):
    from tc_power_interface.recording.recorder import RecorderState, TelemetryRecorder

    rec = TelemetryRecorder(tmp_path)
    first = rec.start("a", {})
    rec.stop()
    second = rec.start("b", {})  # the operator's manual run, started after the first ended
    assert rec.stop_if_current(first.name, "recording_stopped_link_lost") is None
    assert rec.state is RecorderState.RECORDING  # the stale name never stops the newer run
    assert rec.stop_if_current(second.name, "recording_stopped_link_lost") == second
    labels = [e["label"] for e in json.loads((second / "events.json").read_text())]
    assert labels.index("recording_stopped_link_lost") < labels.index("recording_stopped")
    # the losing call must not have written its event into the manual run
    rec2 = TelemetryRecorder(tmp_path)
    third = rec2.start("c", {})
    rec2.stop_if_current("not-this-run", "recording_stopped_link_lost")
    rec2.stop()
    labels3 = [e["label"] for e in json.loads((third / "events.json").read_text())]
    assert "recording_stopped_link_lost" not in labels3


def test_stale_auto_run_never_stops_a_later_manual_run(tmp_path):
    with _client(tmp_path) as c:
        c.post("/api/rf/enable")
        assert _wait_active(c, True)
        c.app.state.recorder.stop()  # the auto run ends behind the app's back (HTTP-stop race)
        c.post("/api/recording/start", json={"name": "manual", "notes": ""})
        c.app.state.controller.on_link_dropped()
        time.sleep(0.3)
        assert c.get("/api/recording/status").json()["active"] is True


def test_link_drop_does_not_block_the_poll_thread(tmp_path):
    with _client(tmp_path) as c:
        c.post("/api/rf/enable")
        assert _wait_active(c, True)
        run = c.get("/api/recording/status").json()["run"]
        assert _slow_first_write(c.app.state.recorder, 0.5).wait(3.0)  # writer is mid-stall
        t0 = time.monotonic()
        c.app.state.controller.on_link_dropped()
        assert time.monotonic() - t0 < 0.2
        assert _wait_idle(c, timeout=6.0)
        assert (tmp_path / run / "manifest.json").exists()


def test_disconnect_stops_an_auto_started_recording(tmp_path):
    with _client(tmp_path) as c:
        c.post("/api/rf/enable")
        assert _wait_active(c, True)
        run = c.get("/api/recording/status").json()["run"]
        assert c.post("/api/disconnect").status_code == 200
        assert _wait_idle(c)
        labels = [e["label"] for e in json.loads((tmp_path / run / "events.json").read_text())]
        assert "recording_stopped_disconnected" in labels


def test_disconnect_leaves_a_manual_recording_alone(tmp_path):
    with _client(tmp_path) as c:
        c.post("/api/recording/start", json={"name": "manual", "notes": ""})
        c.post("/api/disconnect")
        time.sleep(0.2)
        assert c.get("/api/recording/status").json()["active"] is True


def test_link_drop_stops_an_auto_started_recording(tmp_path):
    # 2026-10-06: run 20261006_164701 stayed open 14+ min with no rows after the generator died.
    with _client(tmp_path) as c:
        c.post("/api/rf/enable")
        assert _wait_active(c, True)
        run = c.get("/api/recording/status").json()["run"]
        c.app.state.controller.on_link_dropped()
        assert _wait_idle(c)  # the stop runs off the poll thread, so it lands a moment later
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


def _stopping_with_slow_drain(c, drain_s):
    """Start a manual run, then stop it on a thread whose drain takes ~drain_s. Returns the thread
    once the recorder is STOPPING."""
    from tc_power_interface.recording.recorder import RecorderState

    rec = c.app.state.recorder
    c.post("/api/recording/start", json={"name": "prev", "notes": ""})
    time.sleep(0.2)
    started = _slow_first_write(rec, drain_s)
    assert started.wait(3.0)  # the writer is now stuck in the slow write: the stop will drain
    stopper = threading.Thread(target=lambda: c.post("/api/recording/stop"))
    stopper.start()
    assert _wait_state(rec, RecorderState.STOPPING)
    return stopper


def test_rf_on_edge_skipped_during_a_drain_still_gets_its_recording(tmp_path):
    with _client(tmp_path) as c:
        stopper = _stopping_with_slow_drain(c, 0.8)
        c.post("/api/rf/enable")  # the rising edge lands while the previous run is STOPPING
        time.sleep(0.3)
        assert c.get("/api/recording/status").json()["active"] is False  # still draining
        stopper.join()
        assert _wait_active(c, True)  # RF is still on: the skipped edge is retried
        assert "RF_" in c.get("/api/recording/status").json()["run"]


def test_rf_off_before_the_drain_ends_cancels_the_pending_auto_start(tmp_path):
    with _client(tmp_path) as c:
        stopper = _stopping_with_slow_drain(c, 0.8)
        c.post("/api/rf/enable")
        time.sleep(0.2)
        c.post("/api/rf/disable")
        time.sleep(0.2)  # the poll loop sees RF off while still draining
        stopper.join()
        time.sleep(0.4)
        assert c.get("/api/recording/status").json()["active"] is False


def test_rf_already_on_before_auto_log_is_enabled_is_not_recorded(tmp_path):
    with _client(tmp_path) as c:
        c.put("/api/auto-log", json={"enabled": False})
        c.post("/api/rf/enable")
        time.sleep(0.3)
        c.put("/api/auto-log", json={"enabled": True})
        time.sleep(0.4)  # edge semantics: RF that was on first is not retroactively recorded
        assert c.get("/api/recording/status").json()["active"] is False
