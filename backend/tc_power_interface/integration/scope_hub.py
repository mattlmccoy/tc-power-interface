"""Glue between the scope link, level tracker, flags, and the per-run ScopeRecorder.

The controller listener calls on_snapshot() every telemetry poll (keeps level settling at
telemetry rate); the scope thread calls on_reading(). WARN-ONLY: the hub holds no reference to
the controller and never commands the generator. Limit breaches become flags and run events.
"""

from __future__ import annotations

import math
import threading
import time
from dataclasses import asdict
from pathlib import Path
from typing import Any

from tc_power_interface.analysis.flux import b_pk_mt, limit_flags
from tc_power_interface.analysis.scope_flags import SessionFlagger
from tc_power_interface.control.level_tracker import LevelTracker
from tc_power_interface.integration.scope_link import (
    Reading,
    ScopeLink,
    ScopeResource,
    list_visa_resources,
    open_visa,
)
from tc_power_interface.integration.scope_settings import (
    ScopeSettings,
    load_settings,
    save_settings,
)
from tc_power_interface.recording.recorder import TelemetryRecorder
from tc_power_interface.recording.scope_recorder import ScopeRecorder

__all__ = ["EVENT_FLAGS", "STALE_MIN_S", "STALE_POLLS", "ScopeHub"]

#: Flags that become run events (on onset only, so a persistent condition logs once per episode).
EVENT_FLAGS = ("probe_warn", "probe_hard", "flux_stop", "clipped", "attn_mismatch")
#: A reading older than max(STALE_MIN_S, STALE_POLLS x poll interval) is not shown as live.
STALE_MIN_S = 2.0
STALE_POLLS = 5
_RECORDING_KEYS = ("vrms_v", "b_pk_mt", "f0_hz", "h2_pct", "h3_pct", "level_w", "level_state",
                   "valid", "flags")
_TELEMETRY_KEYS = ("forward_w", "reverse_w", "tune_cap_percent", "load_cap_percent")


def _open(resource: str) -> ScopeResource:
    return open_visa(resource)  # looked up at call time so tests can swap the VISA opener


class ScopeHub:
    def __init__(self, root: Path, recorder: TelemetryRecorder) -> None:
        self.root = Path(root)
        self.recorder = recorder
        self.settings = load_settings(self.root)
        self._lock = threading.Lock()
        self._tracker = LevelTracker(self.settings.tol_w, self.settings.settle_s)
        self._flagger = SessionFlagger()
        self._ctx: dict[str, Any] = {}
        self._latest: dict[str, Any] | None = None
        self._run: ScopeRecorder | None = None
        self._finalized: Path | None = None
        self._active_flags: set[str] = set()
        self._flags_run: Path | None = None
        self._flagger_run: Path | None = None
        self.link = ScopeLink(opener=_open, on_reading=self.on_reading)
        recorder.add_finalizer(self._finalize_run)

    # --- settings / connection ---
    def update_settings(self, s: ScopeSettings) -> None:
        """Apply new settings. Link-level fields restart a running link, so the poll thread and
        the hub (waveform header, channel) always agree; the level tracker is rebuilt only when
        its own rules change, so a label edit never drops an assigned level.

        Saved BEFORE anything changes in memory: a failed save raises and changes nothing."""
        save_settings(self.root, s)
        with self._lock:
            old = self.settings
            self.settings = s
            if (s.tol_w, s.settle_s) != (old.tol_w, old.settle_s):
                self._tracker = LevelTracker(s.tol_w, s.settle_s)
            if (s.probe_attn, s.geometry) != (old.probe_attn, old.geometry):
                self._flagger = SessionFlagger()  # heuristic baselines no longer comparable
        link_fields = ("resource", "channel", "poll_interval_s")
        changed = any(getattr(s, f) != getattr(old, f) for f in link_fields)
        if changed and self.link.status()["running"]:
            if s.resource:
                self.connect()  # restart on the new resource/channel/rate
            else:
                self.disconnect()  # resource cleared: nothing to poll

    def connect(self) -> None:
        if not self.settings.resource:
            raise ValueError("set a VISA resource first")
        if self.link.is_running_with(self.settings):
            return  # already polling this resource/channel/rate: keep the live session
        self.link.stop()
        self._clear_latest()  # a new session never shows the previous session's reading
        self.link.start(self.settings)

    def disconnect(self) -> None:
        self.link.stop()
        self._clear_latest()

    def _clear_latest(self) -> None:
        with self._lock:
            self._latest = None

    @staticmethod
    def resources() -> list[str]:
        return list_visa_resources()

    # --- inputs ---
    def on_snapshot(self, snap: dict[str, Any]) -> None:
        t = snap.get("telemetry") or {}
        sp = snap.get("last_setpoint_w")
        with self._lock:
            a = self._tracker.update(
                time.monotonic(), setpoint_w=sp, forward_w=t.get("forward_w"),
                rf_on=bool(t.get("rf_on")),
            )
            self._ctx = {
                "setpoint_w": sp, "level_w": a.level_w, "level_state": a.state.value,
                **{k: t.get(k) for k in _TELEMETRY_KEYS},
            }

    def _flags(
        self, r: Reading, s: ScopeSettings, level_w: float | None
    ) -> tuple[list[str], float | None]:
        cap, fit = r.capture, r.fit
        b = None if fit is None else b_pk_mt(fit.vrms_v, fit.f0_hz, s.geometry)
        flags: list[str] = []
        if cap.clipped:
            flags.append("clipped")
        if not math.isclose(cap.attn, s.probe_attn, rel_tol=1e-6):
            flags.append("attn_mismatch")
        if fit is not None:
            flags += limit_flags(fit.vrms_v, b, s.limits)
            flags += self._flagger.update(
                t_s=time.monotonic(), level_w=level_w, vrms_v=fit.vrms_v,
                resid_v=fit.resid_v, h2_pct=fit.h2_pct,
            )
        return flags, b

    def on_reading(self, r: Reading) -> None:
        s = self.settings
        cap, fit = r.capture, r.fit
        run_dir = self.recorder.run_dir
        with self._lock:
            ctx = dict(self._ctx) or {"level_w": None, "level_state": "rf_off"}
            if run_dir is not None and run_dir != self._flagger_run:
                self._flagger_run, self._flagger = run_dir, SessionFlagger()  # new run, new session
        flags, b = self._flags(r, s, ctx.get("level_w"))
        reading: dict[str, Any] = {
            "host_timestamp_ns": r.host_timestamp_ns, **ctx,
            "vrms_v": None if fit is None else fit.vrms_v,
            "f0_hz": None if fit is None else fit.f0_hz,
            "resid_v": None if fit is None else fit.resid_v,
            "vmin_v": float(cap.volts.min()), "vmax_v": float(cap.volts.max()),
            "h2_pct": None if fit is None else fit.h2_pct,
            "h3_pct": None if fit is None else fit.h3_pct,
            "b_pk_mt": b, "attn": cap.attn, "vdiv": cap.vdiv, "ofst": cap.ofst, "sara": cap.sara,
            "clipped": cap.clipped, "valid": fit is not None and "attn_mismatch" not in flags,
            "flags": ";".join(flags),
        }
        with self._lock:
            self._latest = reading
        if run_dir is None:
            return  # recorder idle: no run files, no events
        self._emit_onsets(run_dir, flags, reading)
        run = self._open_run(run_dir)
        if run is not None:
            header = {
                "Vertical Scale": f"CH{s.channel}:{cap.vdiv:+E}",
                "Vertical Offset": f"CH{s.channel}:{cap.ofst:+E}",
                "Probe": f"{cap.attn:g}X", "Core": s.core_label,
            }
            run.record(reading, t=cap.t.tolist(), v=cap.volts.tolist(), header=header)

    def _emit_onsets(self, run_dir: Path, flags: list[str], reading: dict[str, Any]) -> None:
        now = {f for f in flags if f in EVENT_FLAGS}
        with self._lock:
            if self._flags_run != run_dir:
                self._flags_run, self._active_flags = run_dir, set()
            onsets = now - self._active_flags
            self._active_flags = now
        for f in sorted(onsets, key=EVENT_FLAGS.index):
            data = {"vrms_v": reading["vrms_v"], "b_pk_mt": reading["b_pk_mt"]}
            if f == "attn_mismatch":
                data |= {"attn": reading["attn"], "probe_attn": self.settings.probe_attn}
            self.recorder.event_for(run_dir, f"scope_{f}", data)

    def _open_run(self, run_dir: Path) -> ScopeRecorder | None:
        """The ScopeRecorder for run_dir, created on first use; None once that run is finalized
        (a reading that sampled run_dir just before stop() must not truncate scope.csv)."""
        with self._lock:
            if run_dir == self._finalized:
                return None
            if self._run is None or self._run.run_dir != run_dir:
                self._run = ScopeRecorder(run_dir)
            return self._run

    def _finalize_run(self, run_dir: Path) -> list[str]:
        with self._lock:
            run, self._run = self._run, None
            self._finalized = run_dir
        if run is None:
            return []
        files = run.finalize()
        return files if run.run_dir == run_dir else []

    def _fresh_latest(self) -> tuple[dict[str, Any] | None, bool, dict[str, Any]]:
        """(latest reading or None, stale?, link status). The single staleness rule: a reading is
        live only while the link is connected and it is not older than
        max(STALE_MIN_S, STALE_POLLS x poll interval)."""
        with self._lock:
            latest = None if self._latest is None else dict(self._latest)
        st = self.link.status()
        stale = False
        if not st["connected"]:
            latest = None  # no data is shown as no data, never as stale or zero values
        elif latest is not None:
            max_age_s = max(STALE_MIN_S, STALE_POLLS * self.settings.poll_interval_s)
            if (time.time_ns() - int(latest["host_timestamp_ns"])) / 1e9 > max_age_s:
                latest, stale = None, True  # link up but stalled: the last reading is not live
        return latest, stale, st

    def recording_fields(self) -> dict[str, Any] | None:
        """Scope values for one telemetry.csv row, or None (blank columns) unless the link is
        connected and the latest reading is fresh. age_ms is the reading's age at call time."""
        latest, _stale, _st = self._fresh_latest()
        if latest is None:
            return None
        out = {k: latest.get(k) for k in _RECORDING_KEYS}
        out["age_ms"] = round((time.time_ns() - int(latest["host_timestamp_ns"])) / 1e6, 1)
        return out

    def snapshot(self) -> dict[str, Any]:
        latest, stale, st = self._fresh_latest()
        return {"status": st, "latest": latest, "stale": stale, "settings": asdict(self.settings)}
