"""Tests for telemetry run recording (mirrors FLIR's experiments/<ts>_<slug>/ layout)."""

import json

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


def test_no_manifest_until_finalized(tmp_path):
    # Absence of manifest.json marks an incomplete/crashed run.
    rec = TelemetryRecorder(tmp_path)
    path = rec.start("crashy", {})
    rec.record(snap())
    assert not (path / "manifest.json").exists()


def test_slug_sanitizes_name(tmp_path):
    rec = TelemetryRecorder(tmp_path)
    path = rec.start("My Run! #2", {})
    rec.stop()
    assert "My_Run" in path.name
    assert "!" not in path.name and "#" not in path.name
