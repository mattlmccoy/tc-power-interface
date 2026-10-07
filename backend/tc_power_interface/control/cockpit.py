"""Cockpit observer: feeds every telemetry tick to the plant estimator, the shadow loop and the core
watch, and reports their state for /api/status and the recorder. It is handed NUMBERS, never the
generator interface, so it cannot command power, RF or caps (D1, spec §5). Resets when a new
recording starts."""

from __future__ import annotations

import math
from typing import Any

from tc_power_interface.control.core_watch import CoreWatch
from tc_power_interface.control.plant_estimator import MIN_UPDATES, PlantEstimate, PlantEstimator
from tc_power_interface.control.run_mode import RunMode
from tc_power_interface.control.shadow_loop import (
    ShadowLoop,
    plateau_c,
    settle_time_s,
    time_to_target_s,
)

SHOW_CONFIDENCE = 0.3


def _power(telemetry: dict[str, Any]) -> float:
    """Forward power in W; a missing, None or non-finite reading counts as 0."""
    try:
        p = float(telemetry.get("forward_w") or 0.0)
    except (TypeError, ValueError):
        return 0.0
    return p if math.isfinite(p) else 0.0


class CockpitObserver:
    # Thread-safety: snapshot()/record_fields() may read across one tick boundary. Attribute
    # reassignments are atomic under the GIL, so there is no lock; the worst case is one 0.5 s
    # tick of plateau/settle inconsistency.
    def __init__(self) -> None:
        self._est = PlantEstimator()
        self._shadow = ShadowLoop()
        self._watch = CoreWatch()
        self._run_id: str | None = None
        self._mode: str | None = None
        self._last: dict[str, Any] = {}
        self._watch_out: list[dict[str, Any]] = []
        self._suggest: float | None = None
        self._estimate: PlantEstimate = self._est.estimate()

    @property
    def grid_samples(self) -> int:
        """5 s grid samples the estimator has taken this run (the shadow steps once per sample)."""
        return self._est.grid_samples

    def observe(
        self,
        *,
        t_s: float,
        telemetry: dict[str, Any],
        part_roi: str | None,
        part_temp_c: float | None,
        temp_status: str,
        roi_temps: list[dict[str, Any]],
        watch: list[str],
        run_id: str | None,
        run_mode: RunMode,
        target_c: float,
        ceiling_w: float,
    ) -> None:
        """Feed one telemetry tick. Only a NEW non-None run id resets; stopping a recording keeps
        the estimate."""
        if run_id is not None and run_id != self._run_id:
            self._est.reset()
            self._shadow.reset()
            self._watch.reset()
            self._suggest = None
            self._estimate = self._est.estimate()
        if run_id is not None:
            self._run_id = run_id
        rf_on = bool(telemetry.get("rf_on"))
        power = _power(telemetry) if rf_on else 0.0  # RF off: any forward reading is not heating
        if run_mode.mode != self._mode:  # a switch restarts the shadow bumplessly
            self._shadow.reset()
            self._suggest = None
            self._mode = run_mode.mode
        before = self._est.grid_samples
        self._estimate = self._est.add(t_s, power, part_temp_c, rf_on=rf_on)
        if part_temp_c is None or not math.isfinite(part_temp_c):
            self._suggest = None  # never leave a suggestion standing on an unknown temperature
        if self._est.grid_samples != before:  # the shadow loop steps once per 5 s grid sample
            if run_mode.mode == "target":  # only to-temperature mode has a target to track
                out = self._shadow.step(
                    self._estimate,
                    temp_c=part_temp_c,
                    power_w=power,
                    target_c=target_c,
                    ceiling_w=ceiling_w,
                )
                self._suggest = out.suggest_w
            else:
                self._suggest = None
        self._watch_out = self._watch.update(t_s, roi_temps, watch)
        self._last = {
            "part_roi": part_roi,
            "part_temp_c": part_temp_c,
            "temp_status": temp_status,
            "power_w": power,
            "run_mode": run_mode.mode,
            "target_c": target_c,
        }

    def _shadow_block(self) -> dict[str, Any]:
        e, last = self._estimate, self._last
        temp, power = last.get("part_temp_c"), last.get("power_w", 0.0)
        plateau = settle = ttt = None
        if e.valid and e.t_amb_c is not None and e.k_c_per_w is not None and e.tau_s is not None:
            if temp is not None:
                plateau = plateau_c(e.t_amb_c, e.k_c_per_w, power)
                settle = settle_time_s(plateau, temp, e.tau_s)
                if last.get("run_mode") == "target":
                    ttt = time_to_target_s(plateau, last["target_c"], temp, e.tau_s)
        why = (
            None
            if e.valid
            else ("learning" if e.updates < MIN_UPDATES else "no consistent first-order fit yet")
        )
        return {
            "valid": e.valid,
            "why": why,
            "k_c_per_w": e.k_c_per_w,
            "tau_s": e.tau_s,
            "confidence": e.confidence,
            "t_amb_c": e.t_amb_c,
            "updates": e.updates,
            "suggest_w": self._suggest,
            "plateau_c": plateau,
            "settle_s": settle,
            "ttt_s": ttt,
            "show": e.valid and e.confidence >= SHOW_CONFIDENCE,
        }

    def snapshot(self) -> dict[str, Any]:
        return {"shadow": self._shadow_block(), "watch": list(self._watch_out)}

    def record_fields(self) -> dict[str, Any]:
        sh, last = self._shadow_block(), self._last
        return {
            "part_roi": last.get("part_roi"),
            "part_temp_c": last.get("part_temp_c"),
            "temp_status": last.get("temp_status"),
            "shadow_k": sh["k_c_per_w"],
            "shadow_tau_s": sh["tau_s"],
            "shadow_conf": sh["confidence"] if sh["valid"] else None,
            "shadow_suggest_w": sh["suggest_w"],
            "shadow_plateau_c": sh["plateau_c"],
            "shadow_ttt_s": sh["ttt_s"],
            "run_mode": last.get("run_mode"),
            "target_c": last.get("target_c") if last.get("run_mode") == "target" else None,
        }
