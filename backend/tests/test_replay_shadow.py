"""Replay re-runs the SAME estimator + shadow over a recording (one implementation, spec §3.5)."""

import csv
import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app
from tc_power_interface.control.cockpit import CockpitObserver
from tc_power_interface.control.run_mode import RunMode
from tc_power_interface.recording.recorder import TelemetryRecorder
from tc_power_interface.recording.replay_shadow import (
    has_roi_data,
    recorded_rois,
    replay_shadow,
)

FIX = json.loads(
    (Path(__file__).parent / "fixtures/flir_20261002_125228_estimator.json").read_text()
)
BASE_NS = 1_790_000_000 * 10**9


def _write_run(root: Path, name: str = "20261002_125227_RF", blank_every: int = 0) -> Path:
    """A recording laid out exactly as the recorder writes it, filled from the REAL 10-02 data.
    ``blank_every`` > 0 blanks every n-th ROI mean (the recorder writes unknown as blank)."""
    d = root / name
    d.mkdir(parents=True)
    with (d / "telemetry.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["host_timestamp_ns", "forward_w", "reverse_w", "rf_on"])
        w.writeheader()
        for t, p in zip(FIX["t_s"], FIX["forward_w"], strict=True):
            w.writerow(
                {
                    "host_timestamp_ns": BASE_NS + int(t * 1e9),
                    "forward_w": p,
                    "reverse_w": 0.0,
                    "rf_on": p >= 1,
                }
            )
    with (d / "roi_temps.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["host_timestamp_ns", "roi", "mean_c"])
        w.writeheader()
        for i, t in enumerate(FIX["t_s"]):
            for roi, series in FIX["rois"].items():
                blank = blank_every > 0 and i % blank_every == 0
                w.writerow(
                    {
                        "host_timestamp_ns": BASE_NS + int(t * 1e9),
                        "roi": roi,
                        "mean_c": None if blank else series[i],
                    }
                )
    (d / "events.json").write_text(
        json.dumps([{"host_timestamp_ns": BASE_NS, "label": "recording_started", "data": {}}])
    )
    return d


def _live(roi: str) -> dict:
    """What the LIVE cockpit observer reports after the same fixture, in to-temperature mode."""
    obs = CockpitObserver()
    for i, t in enumerate(FIX["t_s"]):
        p = FIX["forward_w"][i]
        obs.observe(
            t_s=t,
            telemetry={"forward_w": p, "rf_on": p >= 1},
            part_roi=roi,
            part_temp_c=FIX["rois"][roi][i],
            temp_status="ok",
            roi_temps=[],
            watch=[],
            run_id="live",
            run_mode=RunMode(mode="target"),
            target_c=55.0,
            ceiling_w=200.0,
        )
    return obs.snapshot()["shadow"]


def test_replay_matches_the_live_observer(tmp_path):
    run = _write_run(tmp_path)
    assert recorded_rois(run) == sorted(FIX["rois"])
    out = replay_shadow(run, roi="freehand_sample", target_c=55.0, ceiling_w=200.0)
    assert out["roi"] == "freehand_sample" and out["target_c"] == 55.0
    pts = out["points"]
    assert len(pts) == len(FIX["t_s"])  # one point per 5 s grid sample
    assert pts[0]["t_s"] == 0.0 and pts[-1]["t_s"] == FIX["t_s"][-1]
    live, last = _live("freehand_sample"), pts[-1]
    assert abs(last["k_c_per_w"] - live["k_c_per_w"]) <= 1e-9
    assert abs(last["suggest_w"] - live["suggest_w"]) <= 1e-9
    assert abs(last["confidence"] - live["confidence"]) <= 1e-9
    assert last["temp_c"] == FIX["rois"]["freehand_sample"][-1]
    assert 50 <= last["suggest_w"] <= 75
    for k in ("confidence_fit", "drift_pct", "drifting", "needed_w", "ceiling_w"):
        assert last[k] == live[k]  # the replay card can say "still drifting" / "at the ceiling"
    assert set(last) == {
        "t_s", "temp_c", "k_c_per_w", "tau_s", "confidence", "suggest_w", "plateau_c",
        "confidence_fit", "drift_pct", "drifting", "needed_w", "ceiling_w",
    }


def test_replay_on_another_roi_differs(tmp_path):
    run = _write_run(tmp_path)
    free = replay_shadow(run, roi="freehand_sample", target_c=55.0, ceiling_w=200.0)
    sq = replay_shadow(run, roi="SQ_SAMPLE", target_c=55.0, ceiling_w=200.0)
    assert sq["roi"] == "SQ_SAMPLE"
    assert sq["points"][-1]["temp_c"] == FIX["rois"]["SQ_SAMPLE"][-1]
    k_free, k_sq = free["points"][-1]["k_c_per_w"], sq["points"][-1]["k_c_per_w"]
    live_sq = _live("SQ_SAMPLE")["k_c_per_w"]
    assert k_sq == live_sq or abs(k_sq - live_sq) <= 1e-9
    assert k_free != k_sq


def test_unknown_roi_temperatures_are_skipped(tmp_path):
    run = _write_run(tmp_path, blank_every=3)
    pts = replay_shadow(run, roi="freehand_sample", target_c=55.0, ceiling_w=200.0)["points"]
    assert pts[0]["temp_c"] is None and pts[3]["temp_c"] is None
    assert pts[0]["suggest_w"] is None  # never a suggestion on an unknown temperature
    assert pts[1]["temp_c"] == FIX["rois"]["freehand_sample"][1]


def test_a_reading_older_than_the_join_tolerance_is_unknown(tmp_path):
    run = _write_run(tmp_path)
    # Drop every ROI row after t = 100 s: later telemetry rows must NOT reuse the stale reading.
    cut = BASE_NS + 100 * 10**9
    rows = list(csv.DictReader((run / "roi_temps.csv").open(newline="")))
    with (run / "roi_temps.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["host_timestamp_ns", "roi", "mean_c"])
        w.writeheader()
        w.writerows(r for r in rows if int(r["host_timestamp_ns"]) <= cut)
    pts = replay_shadow(run, roi="freehand_sample", target_c=55.0, ceiling_w=200.0)["points"]
    by_t = {p["t_s"]: p["temp_c"] for p in pts}
    assert by_t[100.0] is not None and by_t[105.0] is None


def test_unrecorded_roi_raises_file_not_found(tmp_path):
    run = _write_run(tmp_path)
    try:
        replay_shadow(run, roi="no_such_roi", target_c=55.0, ceiling_w=200.0)
    except FileNotFoundError:
        pass
    else:
        raise AssertionError("expected FileNotFoundError")


def _client(tmp_path):
    return TestClient(
        create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path)
    )


def test_api_replay_endpoints(tmp_path):
    run = _write_run(tmp_path).name
    with _client(tmp_path) as c:
        runs = {r["run"]: r for r in c.get("/api/recordings").json()["runs"]}
        assert runs[run]["has_roi_data"] is True
        assert "freehand_sample" in c.get(f"/api/recordings/{run}/rois").json()["rois"]
        r = c.get(f"/api/recordings/{run}/shadow", params={"roi": "SQ_SAMPLE", "target": 55})
        assert r.status_code == 200
        body = r.json()
        assert body["roi"] == "SQ_SAMPLE" and body["points"]
        live_sq = _live("SQ_SAMPLE")
        assert abs(body["points"][-1]["suggest_w"] - live_sq["suggest_w"]) <= 1e-9
        bad_roi = c.get(f"/api/recordings/{run}/shadow", params={"roi": "nope", "target": 55})
        assert bad_roi.status_code == 404
        for bad in ({"target": "nan"}, {"target": "inf"}, {"target": 55, "ceiling": "-inf"}):
            q = {"roi": "SQ_SAMPLE", **bad}
            assert c.get(f"/api/recordings/{run}/shadow", params=q).status_code == 422
        ev = c.get(f"/api/recordings/{run}/events.json")
        assert ev.status_code == 200
        assert any(e["label"] == "recording_started" for e in ev.json())
        for path in ("rois", "shadow?roi=SQ_SAMPLE&target=55", "events.json"):
            assert c.get(f"/api/recordings/..%2Fx/{path}").status_code in (400, 404)
            assert c.get(f"/api/recordings/nope/{path}").status_code == 404


def test_api_run_without_roi_data(tmp_path):
    d = _write_run(tmp_path, name="20260930_100000_old")
    (d / "roi_temps.csv").unlink()
    (d / "events.json").unlink()
    with _client(tmp_path) as c:
        runs = {r["run"]: r for r in c.get("/api/recordings").json()["runs"]}
        assert runs[d.name]["has_roi_data"] is False
        assert c.get(f"/api/recordings/{d.name}/rois").json() == {"rois": []}
        r = c.get(f"/api/recordings/{d.name}/shadow", params={"roi": "SQ_SAMPLE", "target": 55})
        assert r.status_code == 404
        assert c.get(f"/api/recordings/{d.name}/events.json").status_code == 404


def test_a_recording_from_the_current_recorder_is_replayable(tmp_path):
    """Guards the file contract: what TelemetryRecorder writes today is what replay reads."""
    rec = TelemetryRecorder(tmp_path)
    run = rec.start("contract", {})
    t0 = time.time_ns()
    for i in range(3):
        rec.record(
            {
                "telemetry": {"host_timestamp_ns": t0 + i * 5 * 10**9, "forward_w": 40.0,
                              "rf_on": True},
                "state": "running",
                "roi_temps": [
                    {"name": "part", "mean_c": 30.0 + i, "valid": True},
                    {"name": "other", "mean_c": 99.0, "valid": False},
                ],
            }
        )
    rec.stop()
    assert recorded_rois(run) == ["other", "part"]
    pts = replay_shadow(run, roi="part", target_c=55.0, ceiling_w=200.0)["points"]
    assert [p["t_s"] for p in pts] == [0.0, 5.0, 10.0]
    assert [p["temp_c"] for p in pts] == [30.0, 31.0, 32.0]
    other = replay_shadow(run, roi="other", target_c=55.0, ceiling_w=200.0)["points"]
    assert all(p["temp_c"] is None for p in other)  # an invalid reading is recorded as unknown


def test_a_header_only_roi_file_is_not_roi_data(tmp_path):
    """The recorder always creates roi_temps.csv; with no FLIR feed it holds only the header.
    That run must not advertise ROI data it does not have."""
    rec = TelemetryRecorder(tmp_path)
    run = rec.start("no_flir", {})
    rec.record({"telemetry": {"host_timestamp_ns": time.time_ns(), "forward_w": 0.0,
                              "rf_on": False}, "state": "idle"})
    rec.stop()
    assert (run / "roi_temps.csv").is_file()
    with _client(tmp_path) as c:
        runs = {r["run"]: r for r in c.get("/api/recordings").json()["runs"]}
        assert runs[run.name]["has_roi_data"] is False
        assert c.get(f"/api/recordings/{run.name}/rois").json() == {"rois": []}


# --- review fixes: corrupt timestamps, damaged files, escapes, stat-first has_roi_data ----------

def _rewrite_telemetry(run: Path, insert_at: int, ns: int) -> None:
    """Insert one telemetry row with a corrupt timestamp before data row ``insert_at``."""
    rows = list(csv.DictReader((run / "telemetry.csv").open(newline="")))
    bad = {**rows[0], "host_timestamp_ns": str(ns)}
    rows.insert(insert_at, bad)
    with (run / "telemetry.csv").open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)


@pytest.mark.parametrize(
    ("insert_at", "ns"),
    [
        (0, 0),  # the reviewer's case: first row 0 -> t_s ~1.79e9 s -> ~6 GB of placeholders
        (0, BASE_NS - 7200 * 10**9),  # a first row 2 h too early
        (50, BASE_NS + 10**6 * 10**9),  # a far-future row mid-run (> MAX_GAP_S jump)
        (50, BASE_NS + 10**9),  # a row that goes backwards in time
    ],
)
def test_corrupt_timestamps_are_skipped_and_bounded(tmp_path, insert_at, ns):
    clean = replay_shadow(
        _write_run(tmp_path / "a"), roi="freehand_sample", target_c=55.0, ceiling_w=200.0
    )
    run = _write_run(tmp_path / "b")
    _rewrite_telemetry(run, insert_at, ns)
    t0 = time.perf_counter()
    out = replay_shadow(run, roi="freehand_sample", target_c=55.0, ceiling_w=200.0)
    assert time.perf_counter() - t0 < 2.0
    assert out["points"] == clean["points"]


BINARY = bytes(range(256)) * 64  # invalid UTF-8, NULs, no csv structure (a Dropbox conflict blob)


def test_a_binary_roi_file_is_a_clean_4xx_never_a_500(tmp_path):
    good = _write_run(tmp_path, name="20261002_125227_RF").name
    bad = _write_run(tmp_path, name="20261002_130000_RF")
    (bad / "roi_temps.csv").write_bytes(BINARY)
    with _client(tmp_path) as c:
        listing = c.get("/api/recordings")
        assert listing.status_code == 200  # one bad run never breaks the list
        assert {good, bad.name} <= {r["run"] for r in listing.json()["runs"]}
        assert c.get(f"/api/recordings/{bad.name}/rois").status_code == 422
        q = {"roi": "SQ_SAMPLE", "target": 55}
        assert c.get(f"/api/recordings/{bad.name}/shadow", params=q).status_code == 422
        assert c.get(f"/api/recordings/{good}/shadow", params=q).status_code == 200


def test_a_binary_telemetry_file_is_a_clean_422(tmp_path):
    run = _write_run(tmp_path)
    (run / "telemetry.csv").write_bytes(BINARY)
    with _client(tmp_path) as c:
        q = {"roi": "SQ_SAMPLE", "target": 55}
        assert c.get(f"/api/recordings/{run.name}/shadow", params=q).status_code == 422


def test_has_roi_data_never_raises_on_a_damaged_or_unreadable_file(tmp_path):
    run = tmp_path / "r"
    run.mkdir()
    roi = run / "roi_temps.csv"
    roi.write_bytes(b"\xff\xfe\x00garbage-not-a-csv-header\x00\x81\x82\x83\x84")  # 32 B
    assert 30 < roi.stat().st_size < 36
    assert has_roi_data(run) is False
    roi.chmod(0)
    try:
        assert has_roi_data(run) is False
    finally:
        roi.chmod(0o644)


def test_has_roi_data_is_stat_first(tmp_path, monkeypatch):
    """Dropbox Smart Sync: an online-only file must not be downloaded just to list runs."""
    header = b"host_timestamp_ns,roi,mean_c\r\n"
    run = tmp_path / "r"
    run.mkdir()
    (run / "roi_temps.csv").write_bytes(header)
    opened: list[Path] = []
    real_open = Path.open

    def spy(self, *a, **k):
        opened.append(self)
        return real_open(self, *a, **k)

    monkeypatch.setattr(Path, "open", spy)  # note: write_bytes opens too, so clear after writes
    assert has_roi_data(run) is False and opened == []  # exactly the header: no open
    (run / "roi_temps.csv").write_bytes(header + b"1790000000000000000,part,31.5\r\n")
    opened.clear()
    assert has_roi_data(run) is True and opened == []  # clearly larger: no open
    (run / "roi_temps.csv").write_bytes(header + b"\r\n")  # ambiguous: open and look
    opened.clear()
    assert has_roi_data(run) is False and opened != []


def _cut_last_line(path: Path, keep: int) -> None:
    """Simulate a live recording read mid-write: keep ``keep`` chars of the last line, no EOL."""
    body = path.read_text().rstrip("\r\n")
    start = body.rindex("\n") + 1
    path.write_text(body[: start + keep], newline="")


def test_a_truncated_last_roi_line_is_not_read_as_a_number(tmp_path):
    """'49.68' cut to '4' must not become a 4.0 C reading."""
    run = _write_run(tmp_path)
    roi = run / "roi_temps.csv"
    last = roi.read_text().rstrip("\r\n").rsplit("\n", 1)[1]
    assert last.split(",")[1] == "freehand_sample"
    _cut_last_line(roi, last.rindex(",") + 2)  # "<ts>,freehand_sample,4"
    pts = replay_shadow(run, roi="freehand_sample", target_c=55.0, ceiling_w=200.0)["points"]
    assert pts[-1]["t_s"] == FIX["t_s"][-1]
    assert pts[-1]["temp_c"] is None  # the cut reading is dropped; the prior one is 5 s old


def test_a_truncated_last_telemetry_line_is_not_a_sample(tmp_path):
    run = _write_run(tmp_path)
    _cut_last_line(run / "telemetry.csv", 21)  # "<19-digit ts>,<first char of forward_w>"
    pts = replay_shadow(run, roi="freehand_sample", target_c=55.0, ceiling_w=200.0)["points"]
    assert len(pts) == len(FIX["t_s"]) - 1


def test_a_row_with_missing_fields_is_skipped(tmp_path):
    run = _write_run(tmp_path)
    roi = run / "roi_temps.csv"
    lines = roi.read_text().splitlines(keepends=True)
    lines.insert(5, f"{BASE_NS + 1},freehand_sample\r\n")  # a short, complete line
    roi.write_text("".join(lines), newline="")
    pts = replay_shadow(run, roi="freehand_sample", target_c=55.0, ceiling_w=200.0)["points"]
    assert pts[-1]["temp_c"] == FIX["rois"]["freehand_sample"][-1]


def test_run_names_with_a_null_byte_or_dot_dot_are_400(tmp_path):
    _write_run(tmp_path)
    with _client(tmp_path) as c:
        for name in ("%00", "x%00y", "%2e%2e"):
            for path in ("rois", "events.json", "telemetry.csv", "shadow?roi=a&target=55"):
                assert c.get(f"/api/recordings/{name}/{path}").status_code == 400, (name, path)


def test_a_symlinked_run_dir_escaping_the_root_is_400(tmp_path):
    root, outside = tmp_path / "root", tmp_path / "outside"
    root.mkdir()
    real = _write_run(outside)
    (root / "evil").symlink_to(real, target_is_directory=True)
    with _client(root) as c:
        for path in ("rois", "events.json", "telemetry.csv"):
            assert c.get(f"/api/recordings/evil/{path}").status_code == 400


def test_symlinked_files_inside_a_run_are_not_followed_out(tmp_path):
    root, outside = tmp_path / "root", tmp_path / "outside"
    run = _write_run(root)
    src = _write_run(outside)
    for name in ("events.json", "telemetry.csv", "roi_temps.csv"):
        (run / name).unlink()
        (run / name).symlink_to(src / name)
    assert has_roi_data(run) is False and recorded_rois(run) == []
    with _client(root) as c:
        assert c.get(f"/api/recordings/{run.name}/events.json").status_code == 404
        assert c.get(f"/api/recordings/{run.name}/telemetry.csv").status_code == 404
        assert c.get(f"/api/recordings/{run.name}/rois").json() == {"rois": []}
        q = {"roi": "SQ_SAMPLE", "target": 55}
        assert c.get(f"/api/recordings/{run.name}/shadow", params=q).status_code == 404
