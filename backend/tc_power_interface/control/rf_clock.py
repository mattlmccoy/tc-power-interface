"""RF on-time clock: the current continuous burn, the last burn, and RF-on time in the run.

Pure and clock-injected: the app calls :meth:`RfClock.update` once per controller poll with
``time.monotonic()``, the telemetry ``rf_on`` (None when there is no telemetry) and the active
recording id. Durations are computed at :meth:`RfClock.snapshot` time, so a display polled faster
than the controller (the 10 Hz WebSocket) ticks smoothly between 2 Hz polls.

Display-only: nothing here commands the generator or feeds protection.
"""

from __future__ import annotations

from typing import Any


class RfClock:
    """Track RF burns and the RF-on total of the current recording."""

    def __init__(self) -> None:
        self._rf_on: bool | None = None  # last KNOWN rf state (None until the first sample)
        self._prev_rf: bool | None = None  # the previous update's raw value (may be None)
        self._prev_now: float | None = None
        self._since: float | None = None  # start of the current burn
        self._last_burn_s: float | None = None
        self._run: str | None = None  # the current update's run id (None = not recording)
        self._run_id: str | None = None  # the run the total belongs to (kept after it stops)
        self._run_rf_on_s = 0.0

    def update(self, now_s: float, rf_on: bool | None, run: str | None) -> None:
        """Advance the clock by one controller poll."""
        if run is not None and run != self._run_id:
            self._run_id = run
            self._run_rf_on_s = 0.0
        elif (
            run is not None
            and run == self._run
            and self._prev_rf is True
            and rf_on is not None
            and self._prev_now is not None
        ):
            # RF was on at the previous poll and is known now: that interval was on-time.
            self._run_rf_on_s += max(0.0, now_s - self._prev_now)

        if rf_on is not None:
            if rf_on and not self._rf_on:
                self._since = now_s
            elif not rf_on and self._rf_on and self._since is not None:
                self._last_burn_s = now_s - self._since
                self._since = None
            self._rf_on = rf_on

        self._prev_rf = rf_on
        self._prev_now = now_s
        self._run = run

    def snapshot(self, now_s: float, link_ok: bool) -> dict[str, Any]:
        """The clock as of ``now_s``; ``link_ok`` False marks it stale (no fresh telemetry)."""
        burn_s = None
        if self._rf_on and self._since is not None:
            burn_s = max(0.0, now_s - self._since)
        run_total = self._run_rf_on_s
        if self._prev_rf is True and self._run is not None and self._prev_now is not None:
            run_total += max(0.0, now_s - self._prev_now)  # in-progress partial since the poll
        return {
            "rf_on": self._rf_on,
            "burn_s": burn_s,
            "last_burn_s": self._last_burn_s,
            "run_rf_on_s": run_total,
            "run": self._run,
            "stale": not link_ok,
        }
