"""Re-run the cockpit shadow loop over a recorded run, on any ROI that run recorded (spec §3.5).

ONE implementation: this drives a fresh :class:`CockpitObserver` (the same estimator + shadow loop
the live cockpit uses) over the recording's rows, so live and replay cannot drift apart. It is
handed numbers from disk and returns numbers; it never touches a device.

Reads the recorder's file contract (``recording/recorder.py``):

* ``telemetry.csv`` — ``host_timestamp_ns``, ``forward_w``, ``rf_on`` ("True"/"False", written by
  ``csv.DictWriter`` from a Python bool), among other columns.
* ``roi_temps.csv`` — long format ``host_timestamp_ns, roi, mean_c``; blank ``mean_c`` = unknown.

Both files are streamed (a 2 h run at the 0.5 s tick with 11 ROIs is ~7 MB of ROI rows), never
loaded whole. Recordings live in a Dropbox-synced folder and may be read while still being written,
so damage is expected: undecodable bytes are replaced, a last line without its line ending (cut
mid-write) and rows with missing fields are skipped, a file whose header is not the recorder's
raises :class:`DamagedRecordingError`, implausible / backwards / far-jumping timestamps are
skipped, and a file that is a symlink out of its run directory is treated as absent.
"""

from __future__ import annotations

import csv
import math
import time
from collections.abc import Generator, Iterator
from pathlib import Path
from typing import Any

from tc_power_interface.control.cockpit import CockpitObserver
from tc_power_interface.control.run_mode import RunMode

#: A ROI reading joins a telemetry row only if it is at most this old; older = unknown.
JOIN_TOLERANCE_NS = 2 * 10**9
#: A timestamp more than this past the previous good row is corrupt (or the run stalled): skipped,
#: so one bad row can never make the estimator fill ~1e8 missed grid steps.
MAX_GAP_S = 3600
#: Timestamps before this (2020-01-01 UTC) cannot be from this tool: a corrupt cell such as "0".
MIN_PLAUSIBLE_NS = 1_577_836_800 * 10**9
_FUTURE_SLACK_NS = 86_400 * 10**9
ROI_FILE = "roi_temps.csv"
TELEMETRY_FILE = "telemetry.csv"
_ROI_COLUMNS = ("host_timestamp_ns", "roi", "mean_c")
_TELEMETRY_COLUMNS = ("host_timestamp_ns", "forward_w", "rf_on")
#: The recorder's header-only roi_temps.csv: exactly these bytes (csv.DictWriter writes "\r\n").
_ROI_HEADER_BYTES = len(",".join(_ROI_COLUMNS) + "\r\n")
_MIN_ROI_ROW_BYTES = len("0,x,\r\n")
_POINT_KEYS = (
    "k_c_per_w", "tau_s", "confidence", "suggest_w", "plateau_c",
    "confidence_fit", "drift_pct", "drifting", "needed_w", "ceiling_w",
)  # fmt: skip


class DamagedRecordingError(ValueError):
    """A recording file exists but is not in the recorder's format (e.g. a binary sync conflict)."""


def _int(value: str | None) -> int | None:
    try:
        return int(value) if value else None
    except ValueError:
        return None


def _finite(value: str | None) -> float | None:
    try:
        f = float(value) if value else None
    except ValueError:
        return None
    return f if f is not None and math.isfinite(f) else None


def run_file(run_dir: Path, name: str) -> Path | None:
    """``run_dir/name`` if it is a regular file that really lives in ``run_dir`` (a symlink out of
    the run directory does not count), else None."""
    path = Path(run_dir) / name
    try:
        if path.is_file() and path.resolve().parent == Path(run_dir).resolve():
            return path
    except (OSError, ValueError):
        pass
    return None


def _rows(path: Path, columns: tuple[str, ...]) -> Generator[dict[str, str], None, None]:
    """Complete, well-formed rows of a recorder CSV. Raises DamagedRecordingError on a foreign
    header; an empty file has no rows."""
    with path.open(newline="", encoding="utf-8", errors="replace") as f:
        # Only the last line can lack its line ending: a live recording cut mid-write ("23.4"
        # read as "2"), so it is never parsed.
        reader = csv.DictReader(line for line in f if line.endswith("\n"))
        if reader.fieldnames is None:
            return
        if not set(columns) <= set(reader.fieldnames):
            raise DamagedRecordingError(f"{path.name} is not a recorder file (unexpected header)")
        for r in reader:
            if None not in r and None not in r.values():  # short or long rows are damage
                yield r


def has_roi_data(run_dir: Path) -> bool:
    """True if ``roi_temps.csv`` holds at least one row. The recorder always creates the file, so a
    run with no FLIR feed has a header-only file: that is NOT ROI data. Decided from the file size
    when possible, so listing runs never downloads a Dropbox online-only file. Never raises."""
    path = run_file(run_dir, ROI_FILE)
    if path is None:
        return False
    try:
        size = path.stat().st_size
        if size <= _ROI_HEADER_BYTES:
            return False
        if size >= _ROI_HEADER_BYTES + _MIN_ROI_ROW_BYTES:
            return True
        return next(_rows(path, _ROI_COLUMNS), None) is not None  # ambiguous size: look
    except (OSError, csv.Error, UnicodeError, ValueError):
        return False


def recorded_rois(run_dir: Path) -> list[str]:
    """Sorted unique ROI names in the run's ``roi_temps.csv``; [] if the run has none. Raises
    DamagedRecordingError / csv.Error if the file is damaged."""
    path = run_file(run_dir, ROI_FILE)
    if path is None:
        return []
    return sorted({r["roi"] for r in _rows(path, _ROI_COLUMNS) if r["roi"]})


def _plausible_ns() -> tuple[int, int]:
    return MIN_PLAUSIBLE_NS, time.time_ns() + _FUTURE_SLACK_NS


def _roi_readings(path: Path, roi: str) -> Generator[tuple[int, float | None], None, None]:
    """(timestamp, mean or None) for every row of ``roi``, in file (= time) order."""
    lo, hi = _plausible_ns()
    for r in _rows(path, _ROI_COLUMNS):
        if r["roi"] != roi:
            continue
        ts = _int(r["host_timestamp_ns"])
        if ts is not None and lo <= ts <= hi:
            yield ts, _finite(r["mean_c"])


def _timed_rows(path: Path) -> Generator[tuple[int, dict[str, str]], None, None]:
    """Telemetry rows with a trustworthy timestamp, in order. Skipped: implausible timestamps (a
    corrupt "0"), rows that go backwards, and rows more than MAX_GAP_S past the previous good row.
    The first anchor must agree (within MAX_GAP_S) with the row after it, so one corrupt but
    plausible first row cannot push every real row into a "far jump" and empty the replay."""
    lo, hi = _plausible_ns()
    gap_ns = MAX_GAP_S * 10**9
    prev: int | None = None
    cand: tuple[int, dict[str, str]] | None = None  # the first anchor, awaiting its successor
    for row in _rows(path, _TELEMETRY_COLUMNS):
        ns = _int(row["host_timestamp_ns"])
        if ns is None or not lo <= ns <= hi:
            continue
        if prev is None:
            if cand is not None and abs(ns - cand[0]) <= gap_ns:
                prev = cand[0]
                yield cand
            else:
                cand = (ns, row)
                continue
        if 0 <= ns - prev <= gap_ns:  # backwards or a far jump: corrupt, never a gap to fill
            prev = ns
            yield ns, row
    if prev is None and cand is not None:  # a one-row run
        yield cand


def replay_shadow(
    run_dir: Path, *, roi: str, target_c: float, ceiling_w: float
) -> dict[str, Any]:
    """The shadow loop's history over the run in to-temperature mode, one point per 5 s grid
    sample. Raises FileNotFoundError if the run has no ROI data or never recorded ``roi``, and
    DamagedRecordingError / csv.Error if a file is damaged."""
    run_dir = Path(run_dir)
    roi_path, tel_path = run_file(run_dir, ROI_FILE), run_file(run_dir, TELEMETRY_FILE)
    if roi_path is None or tel_path is None:
        raise FileNotFoundError(f"{run_dir.name} has no ROI temperature data")
    obs = CockpitObserver()
    mode = RunMode(mode="target")
    readings = _roi_readings(roi_path, roi)
    try:
        points, seen = _drive(obs, mode, readings, tel_path, roi, target_c, ceiling_w)
    finally:
        readings.close()  # release the ROI file handle even if a row blows up
    if not seen:
        raise FileNotFoundError(f"ROI {roi!r} was not recorded in {run_dir.name}")
    return {"roi": roi, "target_c": target_c, "points": points}


def _drive(
    obs: CockpitObserver,
    mode: RunMode,
    readings: Iterator[tuple[int, float | None]],
    tel_path: Path,
    roi: str,
    target_c: float,
    ceiling_w: float,
) -> tuple[list[dict[str, Any]], bool]:
    """Merge-join telemetry rows with the ROI readings (both in time order) and feed the observer.
    Returns the points and whether the ROI had any reading at all."""
    pending = next(readings, None)
    seen = pending is not None
    latest: tuple[int, float | None] | None = None
    first_ns: int | None = None
    points: list[dict[str, Any]] = []
    for ns, row in _timed_rows(tel_path):
        # roi_temps.csv is assumed time-ordered (the recorder writes it in order): one pass.
        while pending is not None and pending[0] <= ns:  # latest reading at or before ns
            latest, pending = pending, next(readings, None)
        temp = latest[1] if latest is not None and ns - latest[0] <= JOIN_TOLERANCE_NS else None
        first_ns = ns if first_ns is None else first_ns
        t_s = (ns - first_ns) / 1e9
        before = obs.grid_samples
        obs.observe(
            t_s=t_s,
            telemetry={
                "forward_w": _finite(row["forward_w"]),
                "rf_on": row["rf_on"] == "True",  # DictWriter wrote str(bool)
            },
            part_roi=roi,
            part_temp_c=temp,
            temp_status="ok" if temp is not None else "unknown",
            roi_temps=[],
            watch=[],
            run_id="replay",
            run_mode=mode,
            target_c=target_c,
            ceiling_w=ceiling_w,
        )
        if obs.grid_samples != before:
            shadow = obs.snapshot()["shadow"]
            points.append({"t_s": t_s, "temp_c": temp, **{k: shadow[k] for k in _POINT_KEYS}})
    return points, seen
