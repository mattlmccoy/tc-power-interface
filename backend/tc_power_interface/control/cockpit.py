"""Cockpit observer: feeds every telemetry tick to the plant estimator, the shadow loop and the core
watch, and reports their state for /api/status and the recorder. It is handed NUMBERS, never the
generator interface, so it cannot command power, RF or caps (D1, spec §5). Resets when a new
recording starts.

Honest confidence. The estimator's RLS confidence (``confidence_fit``) only says how well a
first-order model fits the recent data; on a long steady hold with a slow second heat path it
climbs to ~0.93 while K and tau keep creeping (run 20261007_165850: K 0.42 -> 0.53 C/W, tau
176 -> 278 s over 12.8 min at 30.5 W). So the shadow block's ``confidence`` (shown, recorded as
``shadow_conf``, and what ``show`` and the Engage gate use) is capped by how far the estimate moved
in the last DRIFT_WINDOW_S of grid samples:

    drift = max(|K_now - K_then| / K_now, |tau_now - tau_then| / tau_now)
    confidence = min(confidence_fit, clip(1 - drift / DRIFT_FULL, 0, 1))

where ``then`` is the newest valid estimate at least DRIFT_WINDOW_S old. Until such an estimate
exists (a fit younger than 2 min, or one that went invalid and restarted) the drift is unknown and
the confidence is capped at UNKNOWN_DRIFT_FACTOR x the fit: a new fit has not shown it is stable.

Room temperature. The model's T_amb is decided once per run, at the first heating tick, by
``ambient.judge_ambient``. It uses the part readings of the last minute before it, which are kept
across the run reset because the recorder starts a run ON the RF-on edge, plus the operator's room
reference ROI. If it is unknown, the estimator does not learn this run (``why: "room_unknown"``).
"""

from __future__ import annotations

import math
from collections import deque
from typing import Any

from tc_power_interface.control.ambient import REST_WINDOW_S, Ambient, judge_ambient
from tc_power_interface.control.core_watch import CoreWatch
from tc_power_interface.control.plant_estimator import (
    MIN_POWER_W,
    MIN_UPDATES,
    PlantEstimate,
    PlantEstimator,
)
from tc_power_interface.control.run_mode import RunMode
from tc_power_interface.control.shadow_loop import (
    ShadowLoop,
    plateau_c,
    settle_time_s,
    time_to_target_s,
)

SHOW_CONFIDENCE = 0.3
#: How far back the estimate is compared to judge whether it has stopped moving.
DRIFT_WINDOW_S = 120.0
#: Relative drift over DRIFT_WINDOW_S that drives the honest confidence to 0 (10 % -> at most 0.5).
DRIFT_FULL = 0.20
#: Above this relative drift the shadow block reports ``drifting``.
DRIFTING_ABOVE = 0.05
#: No estimate DRIFT_WINDOW_S old yet: drift unknown, confidence capped at this x the fit.
UNKNOWN_DRIFT_FACTOR = 0.5


class _DriftTracker:
    """Valid (t, K, tau) estimates, one per grid sample, kept back to the newest one at least
    DRIFT_WINDOW_S old. An invalid estimate clears it: the next valid one is a new fit."""

    def __init__(self) -> None:
        self._hist: deque[tuple[float, float, float]] = deque()

    def reset(self) -> None:
        self._hist.clear()

    def add(self, t_s: float, e: PlantEstimate) -> None:
        if e.k_c_per_w is None or e.tau_s is None:
            self._hist.clear()
            return
        self._hist.append((t_s, e.k_c_per_w, e.tau_s))
        while len(self._hist) >= 2 and self._hist[1][0] <= t_s - DRIFT_WINDOW_S:
            self._hist.popleft()

    def drift(self) -> float | None:
        """Relative change of K or tau (the larger) over DRIFT_WINDOW_S; None if unknown."""
        if not self._hist:
            return None
        t_then, k_then, tau_then = self._hist[0]
        t_now, k_now, tau_now = self._hist[-1]
        if t_now - t_then < DRIFT_WINDOW_S:
            return None
        return max(abs(k_now - k_then) / k_now, abs(tau_now - tau_then) / tau_now)


def honest_confidence(e: PlantEstimate, drift: float | None) -> float:
    """The fit confidence capped by the drift (see the module docstring); 0 without a valid fit."""
    if not e.valid:
        return 0.0
    if drift is None:
        return UNKNOWN_DRIFT_FACTOR * e.confidence
    return min(e.confidence, min(1.0, max(0.0, 1.0 - drift / DRIFT_FULL)))


def _roi_temp(roi_temps: list[dict[str, Any]], name: str | None) -> float | None:
    """The named ROI's valid, finite mean (°C), or None."""
    if not name:
        return None
    for r in roi_temps:
        if r.get("name") == name and r.get("valid", True):
            try:
                v = float(r.get("mean_c"))  # type: ignore[arg-type]
            except (TypeError, ValueError):
                return None
            return v if math.isfinite(v) else None
    return None


def _ambient_block(a: Ambient | None) -> dict[str, Any] | None:
    if a is None:
        return None
    return {
        "t_c": a.t_amb_c,
        "source": a.source,
        "reason": a.reason,
        "slope_c_per_min": a.slope_c_per_min,
        "roi": a.reference_roi,
    }


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
        self._drift = _DriftTracker()
        self._run_id: str | None = None
        self._mode: str | None = None
        self._last: dict[str, Any] = {}
        self._watch_out: list[dict[str, Any]] = []
        self._suggest: float | None = None
        self._estimate: PlantEstimate = self._est.estimate()
        #: Part readings (t, °C, heating) of the last REST_WINDOW_S; NOT reset with the run. heating
        #: is None when the power was unknown (no generator attached): RF could have been on.
        self._history: deque[tuple[float, float, bool | None]] = deque()
        self._ambient: Ambient | None = None  # this run's room temperature; None = not decided
        self._preset: Ambient | None = None  # replay: a decision to use instead of judging
        self._was_heating = False
        self._heat_since: float | None = None  # start of the current heating streak (any run id)
        self._history_roi: str | None = None  # the ROI the history was read from

    def preset_ambient(self, a: Ambient | None) -> None:
        """REPLAY ONLY: use ``a`` at the run's first heating tick instead of judging (a recording
        holds no minute before RF on). ``Ambient(None, "assumed")`` takes the first heating reading,
        the pre-v0.19 rule, for recordings made before the decision was recorded. Survives the run
        reset."""
        self._preset = a

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
        power_known: bool = True,
        ambient_roi: str | None = None,
    ) -> None:
        """Feed one telemetry tick. Only a NEW non-None run id resets; stopping a recording keeps
        the estimate. ``power_known=False`` (no generator attached: the idle observer) means the
        power is UNKNOWN, not 0 W: the estimator sees RF off, and no plateau / settle /
        time-to-target / suggestion is derived from it. ``ambient_roi`` = the operator's room
        reference ROI (in ``roi_temps``), used only if the part was not at rest before RF on."""
        if run_id is not None and run_id != self._run_id:
            self._est.reset()
            self._shadow.reset()
            self._watch.reset()
            self._drift.reset()
            self._suggest = None
            self._ambient = None
            self._estimate = self._est.estimate()
        if run_id is not None:
            self._run_id = run_id
        rf_on = bool(telemetry.get("rf_on"))
        power = _power(telemetry) if rf_on else 0.0  # RF off: any forward reading is not heating
        if run_mode.mode != self._mode:  # a switch restarts the shadow bumplessly
            self._shadow.reset()
            self._suggest = None
            self._mode = run_mode.mode
        heating = rf_on and power_known and power >= MIN_POWER_W
        # Decide T_amb at the run's first heating tick. A KNOWN value then holds for the run (the
        # part has been heated); an UNKNOWN one is judged again at the next RF-on edge, when the
        # part may have rested meanwhile (a recording can stay open across RF off).
        # The window is the minute before the RF-on EDGE, which may be a tick or two before the run
        # id changes (auto-log can start the run late), and only holds readings of this ROI.
        if part_roi != self._history_roi:
            self._history.clear()
            self._history_roi = part_roi
        if not heating:
            self._heat_since = None
        elif not self._was_heating:
            self._heat_since = t_s
        unknown = self._ambient is not None and self._ambient.t_amb_c is None
        if heating and (self._ambient is None or (unknown and not self._was_heating)):
            # The part is never its own room reference (it would bring back the warm-start bug).
            ref = ambient_roi if ambient_roi != part_roi else None
            t_on = self._heat_since if self._heat_since is not None else t_s
            decided = self._decide(t_on, part_temp_c, roi_temps, ref)
            if decided is not None:
                self._ambient = decided
                self._est.fix_ambient(decided.t_amb_c)
        self._was_heating = heating
        self._remember(t_s, part_temp_c, heating if power_known else None)
        before = self._est.grid_samples
        self._estimate = self._est.add(t_s, power, part_temp_c, rf_on=rf_on and power_known)
        if part_temp_c is None or not math.isfinite(part_temp_c) or not power_known:
            self._suggest = None  # never leave a suggestion standing on an unknown temp / power
        if self._est.grid_samples != before:
            self._drift.add(t_s, self._estimate)
        if self._est.grid_samples != before and power_known:  # once per 5 s grid sample
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
            "power_w": power if power_known else None,
            "run_mode": run_mode.mode,
            "target_c": target_c,
            "ceiling_w": ceiling_w,
        }

    def _decide(
        self,
        t_s: float,
        part_temp_c: float | None,
        roi_temps: list[dict[str, Any]],
        ambient_roi: str | None,
    ) -> Ambient | None:
        """The room temperature at RF on ``t_s``; None = not decidable yet (an assumed room with no
        reading so far: wait for one)."""
        p = self._preset
        if p is None:
            return judge_ambient(
                self._history,
                t_on=t_s,
                ref_roi=ambient_roi,
                ref_temp_c=_roi_temp(roi_temps, ambient_roi),
            )
        if p.source == "assumed" and p.t_amb_c is None:
            if part_temp_c is not None and math.isfinite(part_temp_c):
                return Ambient(float(part_temp_c), "assumed")
            return None
        return p

    def _remember(self, t_s: float, temp: float | None, heating: bool | None) -> None:
        if temp is not None and math.isfinite(temp):
            self._history.append((t_s, float(temp), heating))
        elif heating:  # an unknown reading while heating still marks RF as recent
            self._history.append((t_s, math.nan, True))
        while self._history and self._history[0][0] < t_s - REST_WINDOW_S:
            self._history.popleft()

    def _shadow_block(self) -> dict[str, Any]:
        e, last = self._estimate, self._last
        temp, power = last.get("part_temp_c"), last.get("power_w", 0.0)
        plateau = settle = ttt = None
        if e.valid and e.t_amb_c is not None and e.k_c_per_w is not None and e.tau_s is not None:
            if temp is not None and power is not None:  # unknown power: nothing to project
                plateau = plateau_c(e.t_amb_c, e.k_c_per_w, power)
                settle = settle_time_s(plateau, temp, e.tau_s)
                if last.get("run_mode") == "target":
                    ttt = time_to_target_s(plateau, last["target_c"], temp, e.tau_s)
        needed = None
        if last.get("run_mode") == "target" and e.valid and e.t_amb_c is not None and e.k_c_per_w:
            needed = max(0.0, (last["target_c"] - e.t_amb_c) / e.k_c_per_w)
        drift = self._drift.drift() if e.valid else None
        conf = honest_confidence(e, drift)
        amb = self._ambient
        if e.valid:
            why = None
        elif amb is not None and amb.t_amb_c is None:
            why = "room_unknown"
        else:
            why = "learning" if e.updates < MIN_UPDATES else "no consistent first-order fit yet"
        return {
            "valid": e.valid,
            "why": why,
            "k_c_per_w": e.k_c_per_w,
            "tau_s": e.tau_s,
            "confidence": conf,
            "confidence_fit": e.confidence,
            "drift_pct": None if drift is None else 100.0 * drift,
            "drifting": drift is not None and drift > DRIFTING_ABOVE,
            "t_amb_c": e.t_amb_c,
            "ambient": _ambient_block(amb),
            "updates": e.updates,
            "suggest_w": self._suggest,
            "plateau_c": plateau,
            "settle_s": settle,
            "ttt_s": ttt,
            "needed_w": needed,
            "ceiling_w": last.get("ceiling_w"),
            "show": e.valid and conf >= SHOW_CONFIDENCE,
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
            "shadow_amb_c": self._ambient.t_amb_c if self._ambient else None,
            "shadow_amb_src": _amb_src(self._ambient),
            "run_mode": last.get("run_mode"),
            "target_c": last.get("target_c") if last.get("run_mode") == "target" else None,
        }


def _amb_src(a: Ambient | None) -> str | None:
    """CSV form of the room-temperature decision: the source, or ``unknown:<reason>``."""
    if a is None:
        return None
    return a.source if a.source is not None else f"unknown:{a.reason}"
