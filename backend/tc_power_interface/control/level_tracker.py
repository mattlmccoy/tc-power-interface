"""Assign readings to the commanded power level once forward power has settled near it.

TC-POWER cannot read the setpoint back (docs/protocol.md:67), so the level is the LAST setpoint
TC-POWER commanded. Front-panel changes show up as OFF_SETPOINT, never as a forced level.
"""

from __future__ import annotations

import enum
from dataclasses import dataclass


class LevelState(enum.Enum):
    ASSIGNED = "assigned"
    SETTLING = "settling"
    OFF_SETPOINT = "off_setpoint"
    NO_SETPOINT = "no_setpoint"
    RF_OFF = "rf_off"


@dataclass(frozen=True)
class LevelAssignment:
    level_w: float | None
    state: LevelState


class LevelTracker:
    def __init__(self, tol_w: float = 1.0, settle_s: float = 3.0) -> None:
        if tol_w <= 0 or settle_s < 0:
            raise ValueError("tol_w must be > 0 and settle_s >= 0")
        self.tol_w = tol_w
        self.settle_s = settle_s
        self._since: float | None = None
        self._sp: float | None = None
        self.current = LevelAssignment(None, LevelState.RF_OFF)

    def _set(self, a: LevelAssignment) -> LevelAssignment:
        self.current = a
        return a

    def update(
        self, t_s: float, *, setpoint_w: float | None, forward_w: float | None, rf_on: bool
    ) -> LevelAssignment:
        if not rf_on or forward_w is None:
            self._since = None
            return self._set(LevelAssignment(None, LevelState.RF_OFF))
        if setpoint_w is None:
            self._since = None
            return self._set(LevelAssignment(None, LevelState.NO_SETPOINT))
        if abs(forward_w - setpoint_w) > self.tol_w:
            self._since = None
            return self._set(LevelAssignment(None, LevelState.OFF_SETPOINT))
        if self._since is None or self._sp != setpoint_w:
            self._since, self._sp = t_s, setpoint_w
        if t_s - self._since >= self.settle_s:
            return self._set(LevelAssignment(setpoint_w, LevelState.ASSIGNED))
        return self._set(LevelAssignment(None, LevelState.SETTLING))
