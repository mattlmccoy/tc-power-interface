"""Tests for telemetry run recording (mirrors FLIR's experiments/<ts>_<slug>/ layout)."""

import json
import threading
import time
from pathlib import Path

import pytest

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


#: The CSV header as it was before the match-readback columns were added (captured from the recorder
#: on main @ a087703). External readers (FLIR, geo-prewarp rig_calibration) key on column NAMES, but
#: new columns must still be APPENDED, never inserted, so nothing positional can shift.
_LEGACY_HEADER = [
    "host_timestamp_ns", "forward_w", "reverse_w", "load_w", "reflected_fraction", "rf_on",
    "temperature_c", "operation_mode", "tuner", "status", "controller_state",
    "thermal_phase", "thermal_mode", "thermal_armed", "thermal_control_temp_c", "thermal_target_c",
    "thermal_recommended_w", "thermal_applied_w",
]


def test_records_match_readback_columns_appended_after_existing(tmp_path):
    """The AIT tune/load cap positions (and manual mode, DC probe, preset slot) are recorded every
    sample — a 2026-09-24 run could not be reconstructed because the CSV had no T/L positions."""
    rec = TelemetryRecorder(tmp_path)
    path = rec.start("match", {})
    s = snap(fwd=200.0, rf=True)
    s["telemetry"].update(
        tune_cap_percent=35.6, load_cap_percent=62.6, manual_mode=True, dc_voltage=0.0,
        preset_slot=1,
    )
    rec.record(s)
    rec.stop()
    rows = (path / "telemetry.csv").read_text().strip().splitlines()
    header = rows[0].split(",")
    assert header[: len(_LEGACY_HEADER)] == _LEGACY_HEADER  # existing order untouched
    # match readback follows the legacy block; scope_* then cockpit columns are appended after it
    n = len(_LEGACY_HEADER)
    assert header[n : n + 5] == [
        "tune_cap_percent", "load_cap_percent", "manual_mode", "dc_voltage", "preset_slot",
    ]  # scope_* columns follow (test_scope_columns_are_appended_...)
    data = dict(zip(header, rows[1].split(","), strict=True))
    assert data["tune_cap_percent"] == "35.6"
    assert data["load_cap_percent"] == "62.6"
    assert data["manual_mode"] == "True"
    assert data["preset_slot"] == "1"


def test_unknown_control_temperature_is_recorded_blank_not_zero(tmp_path):
    # 2026-10-06: 43 of 45 real runs logged thermal_control_temp_c = 0.0 for "no reading".
    rec = TelemetryRecorder(tmp_path)
    path = rec.start("unknown_temp", {})
    s = snap(fwd=40.0, rf=True, ts=1)
    s["thermal"] = {"running": False, "phase": "ramp", "mode": "advisory", "armed": False,
                    "control_temp_c": None,
                    "target_c": 185.0,
                    "recommended_w": 0.0,
                    "applied_w": None}
    rec.record(s)
    rec.stop()
    rows = (path / "telemetry.csv").read_text().strip().splitlines()
    data = dict(zip(rows[0].split(","), rows[1].split(","), strict=True))
    assert data["thermal_control_temp_c"] == ""


def test_event_for_appends_only_to_the_active_run(tmp_path):
    rec = TelemetryRecorder(tmp_path)
    assert rec.event_for(tmp_path / "nope", "x") is False  # idle
    run = rec.start("r", {})
    assert rec.event_for(tmp_path / "other", "x") is False  # not the active run
    assert rec.event_for(run, "scope_clipped", {"a": 1}) is True
    rec.stop()
    assert rec.event_for(run, "late") is False  # stopped run: dropped, not leaked
    events = json.loads((run / "events.json").read_text())
    assert [e["label"] for e in events if e["label"] in ("x", "scope_clipped", "late")] == [
        "scope_clipped"
    ]


SCOPE_COLS = [
    "scope_vrms_v", "scope_b_pk_mt", "scope_f0_hz", "scope_h2_pct", "scope_h3_pct",
    "scope_level_w", "scope_level_state", "scope_valid", "scope_flags", "scope_age_ms",
]


def test_scope_columns_are_appended_after_all_existing_columns(tmp_path):
    rec = TelemetryRecorder(tmp_path)
    path = rec.start("hdr", {})
    rec.stop()
    header = (path / "telemetry.csv").read_text().splitlines()[0].split(",")
    k = header.index("preset_slot") + 1  # old layout untouched before them
    assert header[k : k + len(SCOPE_COLS)] == SCOPE_COLS  # (the cockpit block follows, see below)


def test_records_scope_values_when_scope_block_present(tmp_path):
    rec = TelemetryRecorder(tmp_path)
    path = rec.start("sc", {})
    s = snap(fwd=50.0, rf=True)
    s["scope"] = {"vrms_v": 50.15, "b_pk_mt": 12.5, "f0_hz": 1.0e6, "h2_pct": 0.4, "h3_pct": 0.2,
                  "level_w": 50.0, "level_state": "assigned", "valid": True, "flags": "",
                  "age_ms": 120.0}
    rec.record(s)
    rec.stop()
    rows = (path / "telemetry.csv").read_text().strip().splitlines()
    data = dict(zip(rows[0].split(","), rows[1].split(","), strict=True))
    assert data["scope_vrms_v"] == "50.15"
    assert data["scope_level_state"] == "assigned"
    assert data["scope_valid"] == "True"
    assert data["scope_age_ms"] == "120.0"


def test_scope_columns_blank_not_zero_when_scope_absent(tmp_path):
    rec = TelemetryRecorder(tmp_path)
    path = rec.start("nosc", {})
    rec.record(snap(fwd=10.0))
    s = snap(fwd=10.0)
    s["scope"] = None
    rec.record(s)
    rec.stop()
    rows = (path / "telemetry.csv").read_text().strip().splitlines()
    for line in rows[1:]:
        data = dict(zip(rows[0].split(","), line.split(","), strict=True))
        assert all(data[c] == "" for c in SCOPE_COLS)


# telemetry.csv header BEFORE the cockpit columns (captured from the pre-change code, 2026-10-07;
# main's scope_* block, merged in later, sits between the match fields and the cockpit block).
_PRE_COCKPIT_HEADER = [
    "host_timestamp_ns", "forward_w", "reverse_w", "load_w", "reflected_fraction", "rf_on",
    "temperature_c", "operation_mode", "tuner", "status", "controller_state", "thermal_phase",
    "thermal_mode", "thermal_armed", "thermal_control_temp_c", "thermal_target_c",
    "thermal_recommended_w", "thermal_applied_w", "tune_cap_percent", "load_cap_percent",
    "manual_mode", "dc_voltage", "preset_slot", *SCOPE_COLS,
]
_COCKPIT_TAIL = [
    "setpoint_w", "part_roi", "part_temp_c", "temp_status", "shadow_k", "shadow_tau_s",
    "shadow_conf", "shadow_suggest_w", "shadow_plateau_c", "shadow_ttt_s", "run_mode", "target_c",
]


def _tel(ts: int) -> dict:
    return {
        "host_timestamp_ns": ts, "forward_w": 40.0, "reverse_w": 0.1, "load_w": 39.9,
        "reflected_fraction": 0.0025, "rf_on": True, "temperature_c": 30.0,
        "operation_mode": "m", "tuner": "t", "status": 0,
    }


def test_cockpit_columns_are_appended_and_unknown_is_blank(tmp_path):
    import csv

    rec = TelemetryRecorder(tmp_path)
    run = rec.start("t", {})
    rec.record({
        "telemetry": _tel(1), "state": "connected", "commanded_setpoint_w": 40,
        "cockpit": {"part_roi": "freehand_sample", "part_temp_c": 41.2, "temp_status": "ok",
                    "shadow_k": None, "run_mode": "ladder", "target_c": 55.0},
    })
    rec.stop()
    header = (run / "telemetry.csv").read_text().splitlines()[0].split(",")
    assert header[-14:-2] == _COCKPIT_TAIL
    assert header[:-14] == _PRE_COCKPIT_HEADER  # old layout first, byte-identical, in order
    row = next(csv.DictReader((run / "telemetry.csv").open()))
    assert row["setpoint_w"] == "40" and row["part_temp_c"] == "41.2" and row["shadow_k"] == ""


def test_room_temperature_decision_columns_come_last(tmp_path):
    # v0.19: the shadow's room temperature and where it came from (replay reuses them)
    import csv

    rec = TelemetryRecorder(tmp_path)
    run = rec.start("t", {})
    rec.record({"telemetry": _tel(1), "state": "connected",
                "cockpit": {"shadow_amb_c": None, "shadow_amb_src": "unknown:part_cooling"}})
    rec.record({"telemetry": _tel(2), "state": "connected",
                "cockpit": {"shadow_amb_c": 22.83, "shadow_amb_src": "part_at_rest"}})
    rec.stop()
    header = (run / "telemetry.csv").read_text().splitlines()[0].split(",")
    assert header[-2:] == ["shadow_amb_c", "shadow_amb_src"]
    rows = list(csv.DictReader((run / "telemetry.csv").open()))
    assert [(r["shadow_amb_c"], r["shadow_amb_src"]) for r in rows] == [
        ("", "unknown:part_cooling"), ("22.83", "part_at_rest")]


def test_every_roi_goes_to_a_long_format_sidecar(tmp_path):
    import csv

    rec = TelemetryRecorder(tmp_path)
    run = rec.start("t", {})
    rec.record({"telemetry": _tel(5), "state": "connected", "roi_temps": [
        {"name": "toroid_C", "mean_c": 31.5, "valid": True},
        {"name": "SQ_SAMPLE", "mean_c": None, "valid": False}]})
    rec.stop()
    rows = list(csv.DictReader((run / "roi_temps.csv").open()))
    assert rows == [{"host_timestamp_ns": "5", "roi": "toroid_C", "mean_c": "31.5"},
                    {"host_timestamp_ns": "5", "roi": "SQ_SAMPLE", "mean_c": ""}]  # invalid = blank
    assert "roi_temps.csv" in json.loads((run / "manifest.json").read_text())["checksums"]


def test_non_finite_roi_mean_is_blank_not_nan(tmp_path):
    import csv

    rec = TelemetryRecorder(tmp_path)
    run = rec.start("t", {})
    rec.record({"telemetry": _tel(7), "state": "connected", "roi_temps": [
        {"name": "a", "mean_c": float("nan"), "valid": True},
        {"name": "b", "mean_c": float("inf"), "valid": True}]})
    rec.stop()
    text = (run / "roi_temps.csv").read_text()
    assert "nan" not in text.lower() and "inf" not in text.lower()
    assert [r["mean_c"] for r in csv.DictReader(text.splitlines())] == ["", ""]


def test_run_without_rois_still_has_header_only_sidecar(tmp_path):
    rec = TelemetryRecorder(tmp_path)
    run = rec.start("t", {})
    rec.record(snap(fwd=1.0))
    rec.stop()
    assert (run / "roi_temps.csv").read_text().strip() == "host_timestamp_ns,roi,mean_c"


def test_record_does_not_block_on_slow_roi_write(tmp_path):
    rec = TelemetryRecorder(tmp_path)
    run = rec.start("t", {})
    orig = rec._write_roi_rows

    def slow(rows):
        time.sleep(0.5)  # simulate a slow disk / Dropbox flush
        orig(rows)

    rec._write_roi_rows = slow
    t0 = time.monotonic()
    rec.record({"telemetry": _tel(9), "state": "connected",
                "roi_temps": [{"name": "a", "mean_c": 1.0, "valid": True}]})
    assert time.monotonic() - t0 < 0.1
    rec.stop()  # drains the slow write
    assert "a,1.0" in (run / "roi_temps.csv").read_text()


def test_junk_extras_never_cost_the_core_row(tmp_path):
    import csv

    rec = TelemetryRecorder(tmp_path)
    run = rec.start("t", {})
    rec.record({"telemetry": _tel(3), "state": "connected", "cockpit": "x", "roi_temps": [
        "junk", None, {"name": "", "mean_c": 1.0, "valid": True},
        {"name": 5, "mean_c": 1.0, "valid": True},
        {"name": "a", "mean_c": 30.0, "valid": True}]})
    for bad in ("abc", {"a": 1}, [None], 7):
        rec.record({"telemetry": _tel(4), "state": "connected", "roi_temps": bad, "cockpit": [1]})
    rec.stop()
    assert len(list(csv.DictReader((run / "telemetry.csv").open()))) == 5
    assert json.loads((run / "manifest.json").read_text())["sample_count"] == 5
    assert list(csv.DictReader((run / "roi_temps.csv").open())) == [
        {"host_timestamp_ns": "3", "roi": "a", "mean_c": "30.0"}]


def test_non_finite_setpoint_and_cockpit_values_are_blank(tmp_path):
    import csv

    rec = TelemetryRecorder(tmp_path)
    run = rec.start("t", {})
    rec.record({"telemetry": _tel(1), "state": "connected", "commanded_setpoint_w": float("inf"),
                "cockpit": {"part_roi": "nan", "part_temp_c": float("nan"),
                            "shadow_k": float("inf"), "shadow_tau_s": float("-inf"),
                            "temp_status": "ok", "run_mode": "ladder", "target_c": 55.0}})
    rec.stop()
    row = next(csv.DictReader((run / "telemetry.csv").open()))
    for k in ("setpoint_w", "part_temp_c", "shadow_k", "shadow_tau_s"):
        assert row[k] == "", k
    assert row["part_roi"] == "nan"  # strings are passed through untouched
    assert row["temp_status"] == "ok" and row["run_mode"] == "ladder" and row["target_c"] == "55.0"


def test_numeric_check_is_type_agnostic_and_bool_is_not_a_temperature(tmp_path):
    import csv
    from decimal import Decimal

    rec = TelemetryRecorder(tmp_path)
    run = rec.start("t", {})
    rec.record({"telemetry": _tel(2), "state": "connected", "roi_temps": [
        {"name": "dec", "mean_c": Decimal("31.5"), "valid": True},
        {"name": "dnan", "mean_c": Decimal("NaN"), "valid": True},
        {"name": "flag", "mean_c": True, "valid": True},
        {"name": "text", "mean_c": "oops", "valid": True}]})
    rec.stop()
    got = {r["roi"]: r["mean_c"] for r in csv.DictReader((run / "roi_temps.csv").open())}
    assert got == {"dec": "31.5", "dnan": "", "flag": "", "text": ""}


def test_failed_start_leaks_no_handles_and_stays_idle(tmp_path):
    rec = TelemetryRecorder(tmp_path)
    real_open = Path.open

    def flaky(self, *a, **kw):
        if self.name == "roi_temps.csv":
            raise OSError("disk says no")
        return real_open(self, *a, **kw)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(Path, "open", flaky)
        with pytest.raises(OSError):
            rec.start("t", {})
    assert rec.state is RecorderState.IDLE
    assert rec._csv_file is None and rec._roi_file is None
    assert rec._csv_writer is None and rec._roi_writer is None
    rec.start("again", {})  # recorder is still usable
    rec.stop()
