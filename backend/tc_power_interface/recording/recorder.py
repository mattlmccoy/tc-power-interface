"""Record a telemetry run to ``experiments/<YYYYMMDD_HHMMSS>_<slug>/``.

Mirrors the FLIR recorder's integrity model: ``metadata.json`` is written at start; the
telemetry time-series streams to ``telemetry.csv``; ``events.json`` and ``manifest.json`` are
written only on clean finalization. A missing ``manifest.json`` therefore marks a crashed or
incomplete run.
"""

from __future__ import annotations

import csv
import enum
import hashlib
import json
import logging
import math
import platform
import queue
import re
import threading
import time
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TextIO

from tc_power_interface import __version__

logger = logging.getLogger(__name__)

_TELEMETRY_FIELDS = [
    "host_timestamp_ns",
    "forward_w",
    "reverse_w",
    "load_w",
    "reflected_fraction",
    "rf_on",
    "temperature_c",
    "operation_mode",
    "tuner",
    "status",
]
#: Thermal closed-loop columns (blank when the loop is not running / no thermal block in the snap).
#: CSV column name -> key in the snapshot's ``thermal`` sub-dict.
_THERMAL_FIELDS = {
    "thermal_phase": "phase",
    "thermal_mode": "mode",
    "thermal_armed": "armed",
    "thermal_control_temp_c": "control_temp_c",
    "thermal_target_c": "target_c",
    "thermal_recommended_w": "recommended_w",
    "thermal_applied_w": "applied_w",
}
#: Matching-network / generator readback (the CXN GT block, read every sample). APPENDED after all
#: pre-existing columns so readers keyed on the old layout are unaffected. Added 2026-09-24: an
#: in-run Load retune preceded a transformer-core runaway and the log had no tune/load positions.
_MATCH_FIELDS = ["tune_cap_percent", "load_cap_percent", "manual_mode", "dc_voltage", "preset_slot"]
#: Scope sense-loop columns, APPENDED after the match fields (same precedent). Column -> key in
#: the snapshot's ``scope`` sub-dict (ScopeHub.recording_fields()); blank (never 0) when the
#: scope is disconnected or its reading is stale.
_SCOPE_FIELDS = {
    "scope_vrms_v": "vrms_v",
    "scope_b_pk_mt": "b_pk_mt",
    "scope_f0_hz": "f0_hz",
    "scope_h2_pct": "h2_pct",
    "scope_h3_pct": "h3_pct",
    "scope_level_w": "level_w",
    "scope_level_state": "level_state",
    "scope_valid": "valid",
    "scope_flags": "flags",
    "scope_age_ms": "age_ms",
}
#: Cockpit columns (2026-10-07, spec §3.4), APPENDED after all pre-existing columns
#: (incl. main's scope_* block, which shipped first).
#: Unknown = blank.
_COCKPIT_FIELDS = [
    "part_roi", "part_temp_c", "temp_status", "shadow_k", "shadow_tau_s", "shadow_conf",
    "shadow_suggest_w", "shadow_plateau_c", "shadow_ttt_s", "run_mode", "target_c",
    # v0.19 (appended): the shadow's room temperature and its source ("part_at_rest" | "reference"
    # | "unknown:<reason>"); replay reuses it (recording/replay_shadow.py).
    "shadow_amb_c", "shadow_amb_src",
]
_CSV_FIELDS = [
    *_TELEMETRY_FIELDS, "controller_state", *_THERMAL_FIELDS, *_MATCH_FIELDS, *_SCOPE_FIELDS,
    "setpoint_w", *_COCKPIT_FIELDS,
]
#: Long-format sidecar (roi_temps.csv): the telemetry header is fixed at run start but FLIR ROI
#: names change between sessions, so every ROI is one row per sample here. Unknown mean = blank.
_ROI_FIELDS = ["host_timestamp_ns", "roi", "mean_c"]


def _clean_cell(value: Any) -> Any:
    """Cockpit/setpoint cell: strings and bools pass through; any other value that is a
    non-finite number (NaN/inf, any numeric type) becomes None (blank) — never 'nan'/'inf'."""
    if value is None or isinstance(value, (str, bool)):
        return value
    try:
        f = float(value)
    except (TypeError, ValueError):
        return value
    return value if math.isfinite(f) else None


def _roi_mean(value: Any) -> float | None:
    """ROI mean as a finite float, else None (blank). Bools and non-numeric text are not
    temperatures."""
    if value is None or isinstance(value, bool):
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


class RecorderState(enum.Enum):
    IDLE = "idle"
    RECORDING = "recording"
    STOPPING = "stopping"  # a stop is draining/finalizing; start() is refused until IDLE


def _slug(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_") or "run"


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


class TelemetryRecorder:
    """Write one telemetry run to disk."""

    def __init__(self, experiments_root: Path) -> None:
        self.experiments_root = Path(experiments_root)
        self.state = RecorderState.IDLE
        self._dir: Path | None = None
        self._csv_file: TextIO | None = None
        self._csv_writer: Any = None
        self._roi_file: TextIO | None = None
        self._roi_writer: Any = None
        self._events: list[dict[str, Any]] = []
        self._sample_count = 0
        self._started_monotonic = 0.0
        # Disk writes run on a background thread so a slow flush (e.g. Dropbox syncing the csv) can
        # NEVER block the caller — the controller poll loop records from its own thread, and a
        # stalled write there would trip the staleness watchdog. record() only enqueues.
        self._queue: queue.Queue[tuple[str, Any]] = queue.Queue()
        self._writer_thread: threading.Thread | None = None
        self._writer_stop = threading.Event()
        # Serializes the run lifecycle. stop() can be reached from the poll thread (link drop) and
        # an HTTP thread (operator Stop) at once; the lock lets exactly one finalize.
        # start() only TRY-acquires it, so a start (e.g. the auto-logger on the poll thread) never
        # waits behind a stop that is draining a stalled disk.
        self._stop_lock = threading.Lock()
        self._finalizers: list[Callable[[Path], list[str]]] = []
        # event_for() vs the RECORDING -> STOPPING flip in stop()
        self._event_lock = threading.Lock()

    @property
    def run_dir(self) -> Path | None:
        """The active run directory, or None when idle (or stopping)."""
        return self._dir if self.state is RecorderState.RECORDING else None

    def add_finalizer(self, fn: Callable[[Path], list[str]]) -> None:
        """Register a callback run at stop(), before the manifest.

        Registered once; runs at every stop() for the recorder's lifetime.

        Returned file names (relative to the run dir) are checksummed into the manifest. A failing
        finalizer is logged and recorded as an event, never raised."""
        self._finalizers.append(fn)

    def start(self, name: str, metadata: dict[str, Any]) -> Path:
        if not self._stop_lock.acquire(blocking=False):
            raise RuntimeError("recorder busy (stopping)")
        try:
            return self._start_locked(name, metadata)
        finally:
            self._stop_lock.release()

    def _start_locked(self, name: str, metadata: dict[str, Any]) -> Path:
        if self.state is RecorderState.STOPPING:
            raise RuntimeError("recorder busy (stopping)")
        if self.state is RecorderState.RECORDING:
            raise RuntimeError("recorder already recording")
        self.experiments_root.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        base = f"{stamp}_{_slug(name)}"
        run_dir = self.experiments_root / base
        suffix = 2
        while run_dir.exists():
            run_dir = self.experiments_root / f"{base}_{suffix}"
            suffix += 1
        run_dir.mkdir()

        started_utc = datetime.now(UTC).isoformat()
        meta = {
            "format_version": 1,
            "started_utc": started_utc,
            "experiment": {"name": name, **metadata},
            "software": {
                "name": "tc-power-interface",
                "version": __version__,
                "python": platform.python_version(),
                "platform": platform.platform(),
            },
        }
        (run_dir / "metadata.json").write_text(json.dumps(meta, indent=2))

        try:
            self._csv_file = (run_dir / "telemetry.csv").open("w", newline="")
            self._csv_writer = csv.DictWriter(self._csv_file, fieldnames=_CSV_FIELDS)
            self._csv_writer.writeheader()
            self._roi_file = (run_dir / "roi_temps.csv").open("w", newline="")
            self._roi_writer = csv.DictWriter(self._roi_file, fieldnames=_ROI_FIELDS)
            self._roi_writer.writeheader()
            self._roi_file.flush()
        except BaseException:
            for fh in (self._csv_file, self._roi_file):
                if fh is not None:
                    fh.close()
            self._csv_file = self._roi_file = None
            self._csv_writer = self._roi_writer = None
            raise

        self._dir = run_dir
        self._events = []
        self._sample_count = 0
        self._started_monotonic = time.monotonic()
        # Start the background writer that drains the row queue (fresh queue per run).
        self._queue = queue.Queue()
        self._writer_stop.clear()
        self._writer_thread = threading.Thread(
            target=self._writer_loop, name="tcp-recorder-writer", daemon=True
        )
        self._writer_thread.start()
        self.state = RecorderState.RECORDING
        self.event("recording_started", {"name": name})
        return run_dir

    def record(self, snapshot: dict[str, Any]) -> None:
        """Enqueue one row for the background writer. Builds the row (cheap, CPU-only) and returns
        immediately — NEVER touches the disk on the caller's thread."""
        if self.state is not RecorderState.RECORDING:
            return
        telemetry = snapshot.get("telemetry")
        if telemetry is None:
            return
        row: dict[str, Any] = {k: telemetry.get(k) for k in _TELEMETRY_FIELDS}
        row["controller_state"] = snapshot.get("state")
        thermal = snapshot.get("thermal") or {}
        for col, key in _THERMAL_FIELDS.items():
            row[col] = thermal.get(key)
        for key in _MATCH_FIELDS:
            row[key] = telemetry.get(key)
        scope = snapshot.get("scope")
        scope = scope if isinstance(scope, dict) else {}
        for col, key in _SCOPE_FIELDS.items():
            row[col] = scope.get(key)
        # Optional extras: junk here must never cost the core telemetry row.
        row["setpoint_w"] = _clean_cell(snapshot.get("commanded_setpoint_w"))
        cockpit = snapshot.get("cockpit")
        cockpit = cockpit if isinstance(cockpit, dict) else {}
        for key in _COCKPIT_FIELDS:
            row[key] = _clean_cell(cockpit.get(key))
        ts = telemetry.get("host_timestamp_ns")
        rois = snapshot.get("roi_temps")
        roi_rows = [
            {
                "host_timestamp_ns": ts,
                "roi": r["name"],
                "mean_c": _roi_mean(r.get("mean_c")) if r.get("valid") else None,
            }
            for r in (rois if isinstance(rois, list) else [])
            if isinstance(r, dict) and isinstance(r.get("name"), str) and r["name"]
        ]
        self._queue.put(("telemetry", row))  # unbounded; rows are tiny, a stall lasts only seconds
        if roi_rows:
            self._queue.put(("roi", roi_rows))
        self._sample_count += 1

    def _write_row(self, row: dict[str, Any]) -> None:
        """Actually write+flush one row to disk. Runs ONLY on the writer thread (seam for tests)."""
        if self._csv_writer is not None:
            self._csv_writer.writerow(row)
            if self._csv_file is not None:
                self._csv_file.flush()

    def _write_roi_rows(self, rows: list[dict[str, Any]]) -> None:
        """Write+flush one sample's ROI rows. Runs ONLY on the writer thread (seam for tests)."""
        if self._roi_writer is not None:
            self._roi_writer.writerows(rows)
            if self._roi_file is not None:
                self._roi_file.flush()

    def _writer_loop(self) -> None:
        """Drain the row queue to disk until stopped AND empty, so no queued row is lost on stop."""
        while not self._writer_stop.is_set() or not self._queue.empty():
            try:
                kind, payload = self._queue.get(timeout=0.1)
            except queue.Empty:
                continue
            try:
                if kind == "roi":
                    self._write_roi_rows(payload)
                else:
                    self._write_row(payload)
            except Exception:  # noqa: BLE001 - a failed write must not kill the writer thread
                logger.exception("telemetry recorder write failed")

    def event(self, label: str, data: dict[str, Any] | None = None) -> None:
        self._events.append(
            {
                "host_timestamp_ns": time.time_ns(),
                "label": label,
                "data": data or {},
            }
        )

    def event_for(self, run_dir: Path, label: str, data: dict[str, Any] | None = None) -> bool:
        """Append an event only if run_dir is still the active run (for other threads, e.g. the
        scope poller, whose view of the run may be stale). Returns whether it was recorded."""
        with self._event_lock:
            if self.state is not RecorderState.RECORDING or self._dir != run_dir:
                return False
            self.event(label, data)
            return True

    def stop(self) -> Path | None:
        with self._stop_lock:
            return self._stop_locked()

    def stop_if_current(self, run_name: str, event: str | None = None) -> Path | None:
        """Atomically stop the run named ``run_name`` ONLY if it is still the one recording.

        Returns None (and writes nothing, event included) when a different run is recording or
        none is. ``event`` is recorded just before the stop, inside the same critical section, so a
        stale caller can never label or stop a newer run."""
        with self._stop_lock:
            if (
                self.state is not RecorderState.RECORDING
                or self._dir is None
                or self._dir.name != run_name
            ):
                return None
            if event:
                self.event(event, {})
            return self._stop_locked()

    def _stop_locked(self) -> Path | None:
        if self.state is not RecorderState.RECORDING or self._dir is None:
            return None
        run_dir = self._dir
        self.event("recording_stopped", {"sample_count": self._sample_count})

        # Stop new rows enqueuing, then let the writer drain everything already queued before we
        # close the file and checksum it — so the manifest hashes the COMPLETE telemetry.csv.
        with self._event_lock:  # event_for() sees RECORDING or STOPPING, never a torn flip
            self.state = RecorderState.STOPPING  # record() no-ops; start() refused until IDLE
        try:
            self._finalize(run_dir)
        finally:  # even if finalizing fails, never leave the recorder wedged in STOPPING
            self.state = RecorderState.IDLE
            self._dir = None
        return run_dir

    def _finalize(self, run_dir: Path) -> None:
        if self._writer_thread is not None:
            self._writer_stop.set()
            self._writer_thread.join(timeout=5.0)
            self._writer_thread = None

        if self._csv_file is not None:
            self._csv_file.close()
            self._csv_file = None
        self._csv_writer = None
        if self._roi_file is not None:
            self._roi_file.close()
            self._roi_file = None
        self._roi_writer = None

        extra_files: list[str] = []
        for fn in self._finalizers:
            try:
                extra_files.extend(fn(run_dir))
            except Exception as exc:  # noqa: BLE001 - a broken finalizer must not lose the run
                logger.exception("recorder finalizer failed")
                self.event("finalizer_failed", {"error": str(exc)})

        (run_dir / "events.json").write_text(json.dumps(self._events, indent=2))
        checksums: dict[str, str] = {
            "metadata.json": _sha256(run_dir / "metadata.json"),
            "events.json": _sha256(run_dir / "events.json"),
            "telemetry.csv": _sha256(run_dir / "telemetry.csv"),
            "roi_temps.csv": _sha256(run_dir / "roi_temps.csv"),
        }
        for name in extra_files:
            checksums[name] = _sha256(run_dir / name)

        manifest = {
            "complete": True,
            "sample_count": self._sample_count,
            "duration_s": round(time.monotonic() - self._started_monotonic, 3),
            "checksums": checksums,
        }
        (run_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))
