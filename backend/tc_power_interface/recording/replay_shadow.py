"""Re-run the cockpit shadow loop over a recorded run, on any ROI that run recorded (spec §3.5).

ONE implementation: this drives a fresh :class:`CockpitObserver` (the same estimator + shadow loop
the live cockpit uses) over the recording's rows, so live and replay cannot drift apart. It is
handed numbers from disk and returns numbers; it never touches a device.

Reads the recorder's file contract (``recording/recorder.py``):

* ``telemetry.csv`` — ``host_timestamp_ns``, ``forward_w``, ``rf_on`` ("True"/"False", written by
  ``csv.DictWriter`` from a Python bool), among other columns.
* ``roi_temps.csv`` — long format ``host_timestamp_ns, roi, mean_c``; blank ``mean_c`` = unknown.

Both files are streamed (a 2 h run at the 0.5 s tick with 11 ROIs is ~7 MB of ROI rows), never
loaded whole.
"""

from __future__ import annotations

import csv
import math
from collections.abc import Generator, Iterator
from pathlib import Path
from typing import Any

from tc_power_interface.control.cockpit import CockpitObserver
from tc_power_interface.control.run_mode import RunMode

#: A ROI reading joins a telemetry row only if it is at most this old; older = unknown.
JOIN_TOLERANCE_NS = 2 * 10**9
ROI_FILE = "roi_temps.csv"
TELEMETRY_FILE = "telemetry.csv"
_POINT_KEYS = ("k_c_per_w", "tau_s", "confidence", "suggest_w", "plateau_c")


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


def has_roi_data(run_dir: Path) -> bool:
    """True if ``roi_temps.csv`` holds at least one row. The recorder always creates the file, so a
    run with no FLIR feed has a header-only file: that is NOT ROI data."""
    path = Path(run_dir) / ROI_FILE
    if not path.is_file():
        return False
    with path.open(newline="") as f:
        return next(csv.DictReader(f), None) is not None


def recorded_rois(run_dir: Path) -> list[str]:
    """Sorted unique ROI names in the run's ``roi_temps.csv``; [] if the run has none."""
    path = Path(run_dir) / ROI_FILE
    if not path.is_file():
        return []
    with path.open(newline="") as f:
        return sorted({r["roi"] for r in csv.DictReader(f) if r.get("roi")})


def _roi_readings(path: Path, roi: str) -> Generator[tuple[int, float | None], None, None]:
    """(timestamp, mean or None) for every row of ``roi``, in file (= time) order."""
    with path.open(newline="") as f:
        for r in csv.DictReader(f):
            if r.get("roi") != roi:
                continue
            ts = _int(r.get("host_timestamp_ns"))
            if ts is not None:
                yield ts, _finite(r.get("mean_c"))


def replay_shadow(
    run_dir: Path, *, roi: str, target_c: float, ceiling_w: float
) -> dict[str, Any]:
    """The shadow loop's history over the run in to-temperature mode, one point per 5 s grid
    sample. Raises FileNotFoundError if the run has no ROI data or never recorded ``roi``."""
    run_dir = Path(run_dir)
    roi_path, tel_path = run_dir / ROI_FILE, run_dir / TELEMETRY_FILE
    if not roi_path.is_file() or not tel_path.is_file():
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
    with tel_path.open(newline="") as f:
        for row in csv.DictReader(f):
            ns = _int(row.get("host_timestamp_ns"))
            if ns is None:
                continue
            while pending is not None and pending[0] <= ns:  # latest reading at or before ns
                latest, pending = pending, next(readings, None)
            temp = latest[1] if latest is not None and ns - latest[0] <= JOIN_TOLERANCE_NS else None
            first_ns = ns if first_ns is None else first_ns
            t_s = (ns - first_ns) / 1e9
            before = obs.grid_samples
            obs.observe(
                t_s=t_s,
                telemetry={
                    "forward_w": _finite(row.get("forward_w")),
                    "rf_on": row.get("rf_on") == "True",  # DictWriter wrote str(bool)
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
                points.append(
                    {"t_s": t_s, "temp_c": temp, **{k: shadow[k] for k in _POINT_KEYS}}
                )
    return points, seen
