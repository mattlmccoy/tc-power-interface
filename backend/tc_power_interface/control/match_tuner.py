"""Software matching auto-tuner: model-informed perturb-and-observe on REVERSE power.

Safety: never enables RF; drives caps only while armed + RF on + manual mode; clamps every cap to
[min,max]; holds/backs off when reverse power rises or fails to improve; disarms on fault or RF-off.
The generator's built-in auto-tuner is never engaged (that path does not exist in the codec)."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal


def observe(*, prev: float, curr: float, direction: int, eps: float) -> tuple[int, bool]:
    """Given reverse power before/after a move in ``direction``, return (next_direction, improved).

    Improved (fell by > eps) -> keep direction. Otherwise reverse to probe the other way."""
    improved = curr < prev - eps
    return (direction if improved else -direction, improved)


MATCH_TUNER_BOUNDS: dict[str, tuple[float, float]] = {
    "tune_step": (0.1, 5.0),
    "load_step": (0.1, 5.0),
    "guard": (0.05, 1.0),
}


@dataclass
class MatchTunerPlan:
    mode: Literal["advisory", "auto"] = "advisory"
    tune_step: float = 1.0   # coarse (tune is hyper-sensitive -> larger capture step)
    load_step: float = 0.3   # fine (load is broad -> small trim step)
    min_cap: float = 0.0
    max_cap: float = 100.0
    eps: float = 0.003       # min reverse-fraction improvement that counts
    guard: float = 0.6       # a move that drives reverse to/above this (and worse) is undone + held
    settle_hold: int = 6     # consecutive worsening moves before holding
    resume_delta: float = 0.03  # reverse rise above best that resumes searching
    # The tune well is very sharp: from a large mismatch the reverse signal is flat (no gradient)
    # until the caps are within a couple of widths of the optimum. So the search crosses flat
    # plateaus with momentum (keep direction while flat), and once it enters the well it BRACKETS
    # the minimum by shrinking the step each time a move overshoots (reverse rises).
    shrink: float = 0.5      # step multiplier when a move overshoots (reverse rose)
    min_step: float = 0.1    # smallest step (0.1% = the caps' hardware resolution)

    @classmethod
    def bounded(
        cls, *, mode: str, tune_step: float, load_step: float, guard: float
    ) -> MatchTunerPlan:
        """Build a plan with the mode validated to {advisory, auto} and each numeric field clamped
        into MATCH_TUNER_BOUNDS (an unknown mode falls back to the safe advisory default)."""
        def clamp(name: str, v: float) -> float:
            lo, hi = MATCH_TUNER_BOUNDS[name]
            return max(lo, min(v, hi))

        safe_mode: Literal["advisory", "auto"] = "auto" if mode == "auto" else "advisory"
        return cls(
            mode=safe_mode,
            tune_step=clamp("tune_step", tune_step),
            load_step=clamp("load_step", load_step),
            guard=clamp("guard", guard),
        )


class MatchTuner:
    """Interleaved coordinate descent on reverse power; tune-coarse, load-fine.

    Perturb-and-observe with momentum across the sharp well's flat outer region and step-bracketing
    into its minimum. Drives caps ONLY while armed + RF on + manual + mode==auto; advisory mode only
    records the recommendation. Never enables RF; RF-off auto-disarms."""

    def __init__(self, controller: Any, *, plan: MatchTunerPlan) -> None:
        self.controller = controller
        self.plan = plan
        self.running = False
        self.armed = False
        self.phase: Literal["idle", "searching", "holding"] = "idle"
        self._tune_turn = 0  # weights tune 2:1 over load
        self._dir = {"tune": 1, "load": 1}
        self._base_step = {"tune": plan.tune_step, "load": plan.load_step}
        self._step = dict(self._base_step)
        self._prev_rev: float | None = None
        self._best: float | None = None
        self._no_improve = 0
        self._last_move: dict[str, Any] | None = None
        self._recommended: dict[str, float] | None = None

    # --- lifecycle ---
    def start(self) -> None:
        self.running = True
        self.phase = "searching"
        self._prev_rev = None
        self._best = None
        self._no_improve = 0
        self._dir = {"tune": 1, "load": 1}
        self._base_step = {"tune": self.plan.tune_step, "load": self.plan.load_step}
        self._step = dict(self._base_step)
        self._last_move = None

    def stop(self) -> None:
        self.running = False
        self.armed = False
        self.phase = "idle"

    def arm(self) -> None:
        self.armed = True

    def disarm(self) -> None:
        self.armed = False

    # --- helpers ---
    def _clamp(self, v: float) -> float:
        return max(self.plan.min_cap, min(self.plan.max_cap, round(v, 1)))

    def _next_axis(self) -> Literal["tune", "load"]:
        # tune, tune, load, repeat  (tune weighted 2:1)
        self._tune_turn = (self._tune_turn + 1) % 3
        return "load" if self._tune_turn == 0 else "tune"

    def _read(self, telemetry: dict[str, Any]) -> tuple[float, float, float, bool, bool]:
        tune = float(telemetry.get("tune_cap_percent", getattr(self.controller, "tune", 0.0)))
        load = float(telemetry.get("load_cap_percent", getattr(self.controller, "load", 0.0)))
        rev = float(telemetry["reverse_fraction"])
        rf_on = bool(telemetry.get("rf_on"))
        manual = bool(telemetry.get("manual_mode", True))
        return tune, load, rev, rf_on, manual

    # --- the loop ---
    def tick(self, _dt: float, telemetry: dict[str, Any]) -> None:
        if not self.running:
            return
        tune, load, rev, rf_on, manual = self._read(telemetry)
        # Safety gate: only drive while armed + RF on + manual. RF-off auto-disarms.
        if not rf_on:
            self.armed = False
        can_drive = self.armed and rf_on and manual and self.plan.mode == "auto"

        # Update the direction/step of the axis we moved last tick, from the reverse-power change.
        if self._prev_rev is not None and self._last_move is not None:
            ax = self._last_move["axis"]
            new_dir, improved = observe(
                prev=self._prev_rev, curr=rev, direction=self._dir[ax], eps=self.plan.eps
            )
            worse = rev > self._prev_rev + self.plan.eps
            if improved:
                self._no_improve = 0
            elif worse:
                # Overshot the minimum: reverse (observe already did) and bracket by shrinking.
                self._step[ax] = max(self.plan.min_step, self._step[ax] * self.plan.shrink)
                self._no_improve += 1
            else:
                # Flat plateau far from the well: keep sweeping (override observe's reversal) at the
                # full step so we actually cross it instead of dithering in place.
                new_dir = self._dir[ax]
                self._step[ax] = self._base_step[ax]
            self._dir[ax] = new_dir

        self._best = rev if self._best is None else min(self._best, rev)

        # Guard: a move drove reverse UP to/above the guard level -> undo it and hold a beat. (This
        # is relative to the previous reading, so a legitimately high reverse at a detuned START is
        # worked down normally rather than refused.)
        if (
            can_drive
            and self._last_move is not None
            and self._prev_rev is not None
            and rev > self._prev_rev + self.plan.eps
            and rev >= self.plan.guard
        ):
            self._apply(self._last_move["axis"], -self._last_move["delta"], tune, load)
            self.phase = "holding"
            self._prev_rev = rev
            self._last_move = None
            return

        # Holding: monitor; resume searching if reverse creeps back up (drift).
        if self.phase == "holding":
            if self._best is not None and rev > self._best + self.plan.resume_delta:
                self.phase = "searching"
                self._no_improve = 0
            else:
                self._prev_rev = rev
                self._recommended = {"tune": tune, "load": load}
                return

        if self._no_improve >= self.plan.settle_hold:
            self.phase = "holding"
            self._prev_rev = rev
            return

        # Searching: pick the next axis and step it.
        ax = self._next_axis()
        step = self._step[ax]
        delta = self._dir[ax] * step
        if ax == "tune":
            self._recommended = {"tune": self._clamp(tune + delta), "load": load}
        else:
            self._recommended = {"tune": tune, "load": self._clamp(load + delta)}
        if can_drive:
            self._apply(ax, delta, tune, load)
        self._last_move = {"axis": ax, "delta": delta}
        self._prev_rev = rev

    def _apply(self, axis: str, delta: float, tune: float, load: float) -> None:
        if axis == "tune":
            self.controller.set_tune_capacity(self._clamp(tune + delta))
        else:
            self.controller.set_load_capacity(self._clamp(load + delta))

    def snapshot(self) -> dict[str, Any]:
        return {
            "running": self.running,
            "armed": self.armed,
            "phase": self.phase,
            "mode": self.plan.mode,
            "reverse_fraction": self._prev_rev,
            "best": self._best,
            "last_move": self._last_move,
            "recommended": self._recommended,
        }
