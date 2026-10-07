"""Write sense-loop readings into the active run dir.

scope.csv holds every reading; one raw waveform per settled level goes to
scope_waveforms/<level>W.csv (scope CSV layout); scope_levels.csv and scope_session.json
are written at finalize.

Writes happen on the scope poll thread (1-3 Hz), never on the controller thread.
"""

from __future__ import annotations

import csv
import json
import threading
from collections.abc import Mapping, Sequence
from dataclasses import asdict
from pathlib import Path
from typing import Any, TextIO

from tc_power_interface.analysis.scope_summary import session_mt_per_sqrtw, summarize_levels

__all__ = ["LEVEL_FIELDS", "SCOPE_FIELDS", "ScopeRecorder"]

SCOPE_FIELDS = [
    "host_timestamp_ns", "level_w", "level_state", "setpoint_w", "forward_w", "reverse_w",
    "tune_cap_percent", "load_cap_percent", "vrms_v", "f0_hz", "resid_v", "vmin_v", "vmax_v",
    "h2_pct", "h3_pct", "b_pk_mt", "attn", "vdiv", "ofst", "sara", "clipped", "valid", "flags",
]
LEVEL_FIELDS = [
    "level_w", "n", "vrms_median_v", "vrms_iqr_v", "f0_median_hz", "h2_median_pct", "h3_median_pct",
    "v_per_sqrtw", "b_median_mt",
]
_MIN_LEVEL_W = 10.0


def _level_name(level: float) -> str:
    return f"{level:g}W.csv"


class ScopeRecorder:
    """Per-run writer for scope readings; call finalize() from a TelemetryRecorder finalizer."""

    def __init__(self, run_dir: Path) -> None:
        self.run_dir = Path(run_dir)
        self._lock = threading.Lock()
        self._file: TextIO | None = (self.run_dir / "scope.csv").open("w", newline="")
        self._writer = csv.DictWriter(self._file, fieldnames=SCOPE_FIELDS, extrasaction="ignore")
        self._writer.writeheader()
        self._rows: list[dict[str, Any]] = []
        self._saved_levels: set[float] = set()
        self._files = ["scope.csv"]

    def record(
        self,
        reading: Mapping[str, Any],
        *,
        t: Sequence[float],
        v: Sequence[float],
        header: Mapping[str, str],
    ) -> None:
        with self._lock:
            if self._file is None:
                return
            row = {k: reading.get(k) for k in SCOPE_FIELDS}
            self._writer.writerow(row)
            self._file.flush()
            self._rows.append(row)
            level = reading.get("level_w")
            if (
                reading.get("valid")
                and level is not None
                and float(level) not in self._saved_levels
            ):
                self._saved_levels.add(float(level))
                self._write_waveform(float(level), t, v, header)

    def _write_waveform(
        self, level: float, t: Sequence[float], v: Sequence[float], header: Mapping[str, str]
    ) -> None:
        d = self.run_dir / "scope_waveforms"
        d.mkdir(exist_ok=True)
        name = _level_name(level)
        with (d / name).open("w", newline="") as fh:
            w = csv.writer(fh)
            for k, val in header.items():
                w.writerow([k, val])
            w.writerow(["Second", "Value"])
            for ti, vi in zip(t, v, strict=True):
                w.writerow([f"{ti:.6E}", repr(float(vi))])
        self._files.append(f"scope_waveforms/{name}")

    def finalize(self) -> list[str]:
        """Close scope.csv, write the level summary + session fit; return files for the manifest."""
        with self._lock:
            if self._file is not None:
                self._file.close()
                self._file = None
            levels = summarize_levels(self._rows)
            with (self.run_dir / "scope_levels.csv").open("w", newline="") as fh:
                w = csv.DictWriter(fh, fieldnames=LEVEL_FIELDS)
                w.writeheader()
                for s in levels:
                    w.writerow(asdict(s))
            session = {
                "mt_per_sqrtw": session_mt_per_sqrtw(levels, min_level_w=_MIN_LEVEL_W),
                "min_level_w": _MIN_LEVEL_W,
                "note": "LSQ of B vs sqrt(P) through origin; session-local, drifts with heating; "
                "meter +/-20 % < 10 W",
            }
            (self.run_dir / "scope_session.json").write_text(json.dumps(session, indent=2))
            return [*self._files, "scope_levels.csv", "scope_session.json"]
