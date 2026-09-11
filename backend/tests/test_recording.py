"""Tests for telemetry run recording (mirrors FLIR's experiments/<ts>_<slug>/ layout)."""

import json
import threading
import time

from tc_power_interface.recording.recorder import RecorderState, TelemetryRecorder


def snap(fwd: float = 0.0, rf: bool = False, ts: int = 1) -> dict:
    return {
        "state": "connected",
        "fault_reasons": [],
        "warnings": [],
        "telemetry": {
            "host_timestamp_ns": ts,
            "forward_w": fwd,
            "reverse_w": 0.0,
            "load_w": 0.0,
            "reflected_fraction": 0.0,
            "rf_on": rf,
            "temperature_c": 30.0,
            "operation_mode": "normal",
            "tuner": "analog tuner",
            "status": 0,
        },
    }


def test_start_creates_run_dir_and_metadata(tmp_path):
    rec = TelemetryRecorder(tmp_path)
    path = rec.start("Run one", {"notes": "hello", "backend": "simulated"})
    assert path.parent == tmp_path
    meta = json.loads((path / "metadata.json").read_text())
    assert meta["experiment"]["name"] == "Run one"
    assert meta["experiment"]["notes"] == "hello"
    assert meta["software"]["name"] == "tc-power-interface"
    assert rec.state is RecorderState.RECORDING


def test_record_and_stop_writes_series_and_manifest(tmp_path):
    rec = TelemetryRecorder(tmp_path)
    path = rec.start("r", {})
    for i in range(3):
        rec.record(snap(fwd=float(i), ts=i))
    rec.event("rf_enabled", {"by": "test"})
    rec.stop()

    assert rec.state is RecorderState.IDLE
    rows = (path / "telemetry.csv").read_text().strip().splitlines()
    assert len(rows) == 1 + 3  # header + 3 samples
    assert "forward_w" in rows[0]

    manifest = json.loads((path / "manifest.json").read_text())
    assert manifest["complete"] is True
    assert manifest["sample_count"] == 3

    events = json.loads((path / "events.json").read_text())
    labels = [e["label"] for e in events]
    assert "recording_started" in labels
    assert "rf_enabled" in labels


def test_record_does_not_block_on_slow_write(tmp_path):
    """record() must NOT do disk I/O on the caller (poll) thread — a slow flush (e.g. Dropbox
    syncing telemetry.csv) can't be allowed to stall the control loop. The actual write happens on
    the recorder's background writer thread; stop() drains and joins it."""
    rec = TelemetryRecorder(tmp_path)
    path = rec.start("t", {})
    gate = threading.Event()
    writer_threads: list[str] = []
    orig = rec._write_row
    caller = threading.current_thread().name

    def slow(row):
        writer_threads.append(threading.current_thread().name)
        gate.wait(2.0)  # simulate a slow disk / Dropbox flush
        orig(row)

    rec._write_row = slow
    t0 = time.monotonic()
    rec.record(snap(fwd=1.0))
    dt = time.monotonic() - t0
    assert dt < 0.5, f"record() blocked {dt:.2f}s on the caller thread"

    gate.set()
    rec.stop()  # drains the queue and joins the writer before finalizing
    assert writer_threads and all(name != caller for name in writer_threads)
    rows = (path / "telemetry.csv").read_text().strip().splitlines()
    assert len(rows) == 1 + 1  # header + the one recorded row (written off-thread, drained on stop)


def test_no_manifest_until_finalized(tmp_path):
    # Absence of manifest.json marks an incomplete/crashed run.
    rec = TelemetryRecorder(tmp_path)
    path = rec.start("crashy", {})
    rec.record(snap())
    assert not (path / "manifest.json").exists()


def test_records_thermal_loop_curve(tmp_path):
    rec = TelemetryRecorder(tmp_path)
    path = rec.start("loop", {})
    s = snap(fwd=100.0, rf=True, ts=1)
    s["thermal"] = {
        "running": True, "phase": "ramp", "mode": "auto", "armed": False,
        "control_temp_c": 150.0, "target_c": 185.0, "recommended_w": 120.0, "applied_w": 120,
    }
    rec.record(s)
    rec.stop()
    rows = (path / "telemetry.csv").read_text().strip().splitlines()
    header = rows[0].split(",")
    assert "thermal_phase" in header
    assert "thermal_recommended_w" in header
    assert "thermal_applied_w" in header
    data = dict(zip(header, rows[1].split(","), strict=True))
    assert data["thermal_phase"] == "ramp"
    assert data["thermal_recommended_w"] == "120.0"
    assert data["thermal_target_c"] == "185.0"


def test_records_blank_thermal_when_absent(tmp_path):
    rec = TelemetryRecorder(tmp_path)
    path = rec.start("nolo", {})
    rec.record(snap(fwd=10.0))  # snapshot with no thermal block
    rec.stop()
    rows = (path / "telemetry.csv").read_text().strip().splitlines()
    header = rows[0].split(",")
    assert "thermal_phase" in header  # column present even without loop data
    data = dict(zip(header, rows[1].split(","), strict=True))
    assert data["thermal_phase"] == ""


def test_slug_sanitizes_name(tmp_path):
    rec = TelemetryRecorder(tmp_path)
    path = rec.start("My Run! #2", {})
    rec.stop()
    assert "My_Run" in path.name
    assert "!" not in path.name and "#" not in path.name
