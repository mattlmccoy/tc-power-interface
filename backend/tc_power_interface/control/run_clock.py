"""Run clock: a per-run reminder of how much RF-on time the sims call for.

The operator types a target (the RF-on time a simulation says the run needs). The clock counts RF-on
time only, pausing while RF is off or unknown, and reports when the end is near (WARN_S, FINAL_S)
and when it has passed (overtime keeps counting). It is a REMINDER, not automation: it holds numbers
and has no handle on the controller, so it cannot turn RF on or off (design
docs/superpowers/specs/2026-11-18-run-clock-design.md).

Pure and clock-injected, like ``rf_clock.RfClock``: the app calls :meth:`RunClock.update` once per
controller poll with ``time.monotonic()`` and the telemetry ``rf_on`` (None = unknown). Every
mutator returns the events to record, as ``(label, data)`` pairs.
"""

from __future__ import annotations

import math
import threading
from typing import Any

#: Remaining RF-on time at which the clock turns amber and chimes once.
WARN_S = 120.0
#: Remaining RF-on time at which it turns red and chimes once more.
FINAL_S = 30.0
#: Longest target accepted (a typo guard, not a physical limit).
MAX_TARGET_S = 24 * 3600.0
#: A gap between polls longer than this is unknown time (link stalled or dropped), never RF-on, and
#: the display stops advancing after it. Polls come every 0.5 s.
STALE_S = 3.0

Event = tuple[str, dict[str, Any]]


class RunClock:
    def __init__(self) -> None:
        self._target_s: float | None = None
        self._on_s = 0.0
        self._prev_rf: bool | None = None
        self._prev_now: float | None = None
        self._warned = False
        self._finaled = False
        self._overed = False
        self._dismissed = False
        # update() runs on the poll thread, the rest on API threads; never held while calling out.
        self._mutex = threading.Lock()

    # --- operator actions -----------------------------------------------------------------
    def set(self, target_s: float, now_s: float) -> list[Event]:
        """Start a new clock with ``target_s`` of RF-on time at ``now_s``, replacing any running
        one. RF-on time before ``now_s`` never counts toward it."""
        if not math.isfinite(target_s) or not 0.0 < target_s <= MAX_TARGET_S:
            raise ValueError(f"target must be between 0 and {MAX_TARGET_S:.0f} s, got {target_s}")
        with self._mutex:
            self._target_s = float(target_s)
            self._on_s = 0.0
            if self._prev_now is not None:
                self._prev_now = max(self._prev_now, now_s)  # the next poll counts from now
            self._rearm()
            return [("run_clock_set", {"target_s": self._target_s})]

    def add(self, seconds: float) -> list[Event]:
        """Extend the target by ``seconds``; warnings re-arm if the end moves back out of reach."""
        if not math.isfinite(seconds) or seconds <= 0:
            raise ValueError(f"seconds must be positive, got {seconds}")
        with self._mutex:
            if self._target_s is None:
                return []
            self._target_s = min(MAX_TARGET_S, self._target_s + seconds)
            self._rearm()
            return [("run_clock_extended", {"target_s": self._target_s, "added_s": float(seconds)})]

    def cancel(self, now_s: float) -> list[Event]:
        with self._mutex:
            if self._target_s is None:
                return []
            data = {"target_s": self._target_s, "on_s": round(self._on_at(now_s), 1)}
            self._target_s = None
            self._on_s = 0.0
            self._rearm()
            return [("run_clock_cancelled", data)]

    def dismiss(self, now_s: float) -> list[Event]:
        """Acknowledge the time's-up alert (stops the repeating chime); only once it is over."""
        with self._mutex:
            if self._target_s is None or self._dismissed or self._remaining_at(now_s) > 0:
                return []
            self._dismissed = True
            return [("run_clock_dismissed", {"over_s": round(-self._remaining_at(now_s), 1)})]

    # --- feed -----------------------------------------------------------------------------
    def update(self, now_s: float, rf_on: bool | None) -> list[Event]:
        """Advance by one controller poll; returns the threshold crossings to record."""
        with self._mutex:
            if (
                self._target_s is not None
                and self._prev_rf is True
                and rf_on is not None
                and self._prev_now is not None
                and 0.0 <= now_s - self._prev_now <= STALE_S
            ):
                self._on_s += now_s - self._prev_now  # RF was on through that interval
            self._prev_rf = rf_on
            self._prev_now = now_s
            return self._crossings()

    def reset_link(self) -> None:
        """Forget the RF state (device detached / link dropped); the RF-on count is kept."""
        with self._mutex:
            self._prev_rf = None
            self._prev_now = None

    # --- reads ----------------------------------------------------------------------------
    def snapshot(self, now_s: float) -> dict[str, Any]:
        with self._mutex:
            if self._target_s is None:
                return {"set": False, "target_s": None, "on_s": None, "remaining_s": None,
                        "phase": "off", "counting": False, "dismissed": False}  # fmt: skip
            remaining = self._remaining_at(now_s)
            counting = self._prev_rf is True
            if remaining <= 0:
                phase = "over"
            elif remaining <= FINAL_S:
                phase = "final"
            elif remaining <= WARN_S:
                phase = "warn"
            else:
                phase = "running" if counting else "paused"
            return {
                "set": True,
                "target_s": self._target_s,
                "on_s": round(self._on_at(now_s), 2),
                "remaining_s": round(remaining, 2),
                "phase": phase,
                "counting": counting,
                "dismissed": self._dismissed,
            }

    def record_fields(self, now_s: float) -> dict[str, Any]:
        """The CSV columns: the target and RF-on time so far (blank when no clock is set)."""
        with self._mutex:
            if self._target_s is None:
                return {"clock_target_s": None, "clock_on_s": None}
            return {"clock_target_s": self._target_s, "clock_on_s": round(self._on_at(now_s), 2)}

    # --- internals (caller holds the mutex) ---------------------------------------------------
    def _on_at(self, now_s: float) -> float:
        """RF-on time including the interval since the last poll if RF was on (smooth display)."""
        extra = 0.0
        if self._prev_rf is True and self._prev_now is not None:
            extra = min(STALE_S, max(0.0, now_s - self._prev_now))
        return self._on_s + extra

    def _remaining_at(self, now_s: float) -> float:
        assert self._target_s is not None
        return self._target_s - self._on_at(now_s)

    def _rearm(self) -> None:
        remaining = (self._target_s or 0.0) - self._on_s
        self._warned = self._target_s is not None and remaining <= WARN_S
        self._finaled = self._target_s is not None and remaining <= FINAL_S
        self._overed = self._target_s is not None and remaining <= 0
        self._dismissed = False

    def _crossings(self) -> list[Event]:
        if self._target_s is None:
            return []
        remaining = self._target_s - self._on_s
        out: list[Event] = []
        if not self._warned and remaining <= WARN_S:
            self._warned = True
            out.append(("run_clock_warn", {"remaining_s": round(remaining, 1)}))
        if not self._finaled and remaining <= FINAL_S:
            self._finaled = True
            out.append(("run_clock_final", {"remaining_s": round(remaining, 1)}))
        if not self._overed and remaining <= 0:
            self._overed = True
            out.append(("run_clock_over", {"target_s": self._target_s}))
        return out
