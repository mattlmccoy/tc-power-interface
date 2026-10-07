import csv
import json
from pathlib import Path
from typing import Any

from tc_power_interface.recording.recorder import TelemetryRecorder
from tc_power_interface.recording.scope_recorder import SCOPE_FIELDS, ScopeRecorder


def _reading(level: float | None, vrms: float, valid: bool = True) -> dict[str, Any]:
    r: dict[str, Any] = {k: None for k in SCOPE_FIELDS}
    r.update(
        host_timestamp_ns=1,
        level_w=level,
        level_state="assigned" if level else "settling",
        vrms_v=vrms,
        f0_hz=13.56e6,
        resid_v=0.7,
        vmin_v=-vrms * 1.4,
        vmax_v=vrms * 1.4,
        h2_pct=0.3,
        h3_pct=0.2,
        b_pk_mt=0.105 * vrms,
        valid=valid,
        flags="",
    )
    return r


def test_recorder_finalizer_files_are_in_manifest(tmp_path: Path) -> None:
    rec = TelemetryRecorder(tmp_path)
    run = rec.start("r", {})
    assert rec.run_dir == run

    def fin(d: Path) -> list[str]:
        (d / "extra.csv").write_text("x\n")
        return ["extra.csv"]

    rec.add_finalizer(fin)
    rec.stop()
    man = json.loads((run / "manifest.json").read_text())
    assert "extra.csv" in man["checksums"]
    assert rec.run_dir is None


def test_failing_finalizer_does_not_lose_the_run(tmp_path: Path) -> None:
    rec = TelemetryRecorder(tmp_path)
    run = rec.start("r", {})

    def boom(d: Path) -> list[str]:
        raise RuntimeError("nope")

    rec.add_finalizer(boom)
    rec.stop()
    man = json.loads((run / "manifest.json").read_text())
    assert man["complete"] is True
    events = json.loads((run / "events.json").read_text())
    assert any(e["label"] == "finalizer_failed" for e in events)


def test_scope_recorder_writes_rows_waveform_and_levels(tmp_path: Path) -> None:
    sr = ScopeRecorder(tmp_path)
    t = [-7e-7 + i * 1e-9 for i in range(3)]
    sr.record(_reading(50, 50.0), t=t, v=[1.0, 2.0, 3.0], header={"Vertical Scale": "CH1:+5.0E+01"})
    sr.record(_reading(50, 50.2), t=t, v=[1.0, 2.0, 3.0], header={})
    sr.record(_reading(None, 10.0), t=t, v=[0.0, 0.0, 0.0], header={})
    names = sr.finalize()
    assert set(names) == {
        "scope.csv",
        "scope_levels.csv",
        "scope_session.json",
        "scope_waveforms/50W.csv",
    }
    rows = list(csv.DictReader((tmp_path / "scope.csv").open()))
    assert len(rows) == 3
    lv = list(csv.DictReader((tmp_path / "scope_levels.csv").open()))
    assert lv[0]["level_w"] == "50.0" and lv[0]["n"] == "2"
    wf = (tmp_path / "scope_waveforms" / "50W.csv").read_text().splitlines()
    assert wf[-1].startswith("-6.98")  # time column first, scope-CSV layout
    assert "Second,Value" in wf


def test_waveform_saved_once_per_level_and_invalid_never(tmp_path: Path) -> None:
    sr = ScopeRecorder(tmp_path)
    sr.record(_reading(50, 50.0, valid=False), t=[0.0], v=[9.0], header={})
    sr.record(_reading(50, 50.0), t=[0.0], v=[1.0], header={})
    sr.record(_reading(50, 50.0), t=[0.0], v=[2.0], header={})
    sr.finalize()
    assert (tmp_path / "scope_waveforms" / "50W.csv").read_text().strip().endswith("1.0")


def test_finalizer_runs_on_every_run(tmp_path: Path) -> None:
    rec = TelemetryRecorder(tmp_path)

    def fin(d: Path) -> list[str]:
        (d / "extra.csv").write_text("x\n")
        return ["extra.csv"]

    rec.add_finalizer(fin)
    runs = []
    for name in ("a", "b"):
        runs.append(rec.start(name, {}))
        rec.stop()
    assert runs[0] != runs[1]
    for run in runs:
        assert (run / "extra.csv").exists()
        man = json.loads((run / "manifest.json").read_text())
        assert "extra.csv" in man["checksums"]
