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
import platform
import re
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, TextIO

from tc_power_interface import __version__

_CSV_FIELDS = [
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
    "controller_state",
]


class RecorderState(enum.Enum):
    IDLE = "idle"
    RECORDING = "recording"


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
        self._events: list[dict[str, Any]] = []
        self._sample_count = 0
        self._started_monotonic = 0.0

    def start(self, name: str, metadata: dict[str, Any]) -> Path:
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

        self._csv_file = (run_dir / "telemetry.csv").open("w", newline="")
        self._csv_writer = csv.DictWriter(self._csv_file, fieldnames=_CSV_FIELDS)
        self._csv_writer.writeheader()

        self._dir = run_dir
        self._events = []
        self._sample_count = 0
        self._started_monotonic = time.monotonic()
        self.state = RecorderState.RECORDING
        self.event("recording_started", {"name": name})
        return run_dir

    def record(self, snapshot: dict[str, Any]) -> None:
        if self.state is not RecorderState.RECORDING or self._csv_writer is None:
            return
        telemetry = snapshot.get("telemetry")
        if telemetry is None:
            return
        row = {k: telemetry.get(k) for k in _CSV_FIELDS if k != "controller_state"}
        row["controller_state"] = snapshot.get("state")
        self._csv_writer.writerow(row)
        if self._csv_file is not None:
            self._csv_file.flush()
        self._sample_count += 1

    def event(self, label: str, data: dict[str, Any] | None = None) -> None:
        self._events.append(
            {
                "host_timestamp_ns": time.time_ns(),
                "label": label,
                "data": data or {},
            }
        )

    def stop(self) -> Path | None:
        if self.state is not RecorderState.RECORDING or self._dir is None:
            return None
        run_dir = self._dir
        self.event("recording_stopped", {"sample_count": self._sample_count})

        if self._csv_file is not None:
            self._csv_file.close()
            self._csv_file = None
        self._csv_writer = None

        (run_dir / "events.json").write_text(json.dumps(self._events, indent=2))

        manifest = {
            "complete": True,
            "sample_count": self._sample_count,
            "duration_s": round(time.monotonic() - self._started_monotonic, 3),
            "checksums": {
                "metadata.json": _sha256(run_dir / "metadata.json"),
                "events.json": _sha256(run_dir / "events.json"),
                "telemetry.csv": _sha256(run_dir / "telemetry.csv"),
            },
        }
        (run_dir / "manifest.json").write_text(json.dumps(manifest, indent=2))

        self.state = RecorderState.IDLE
        self._dir = None
        return run_dir
