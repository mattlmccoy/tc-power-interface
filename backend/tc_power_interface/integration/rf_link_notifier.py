"""Detects RF on/off edges from controller snapshots and notifies the FLIR link.

Attach `on_snapshot` as a Controller listener. Emits exactly one notify per rf_on transition; a
falling edge that coincides with a FAULT carries the fault reasons.
"""
from __future__ import annotations

from typing import Any, Protocol


class _Link(Protocol):
    def notify(self, *, state: str, forward_w: float, reflected_fraction: float,
               reason: str) -> None: ...


class RfLinkNotifier:
    def __init__(self, link: _Link) -> None:
        self._link = link
        self._prev_rf_on: bool | None = None

    def on_snapshot(self, snapshot: dict[str, Any]) -> None:
        t = snapshot.get("telemetry")
        if t is None:
            return
        rf_on = bool(t.get("rf_on"))
        prev = self._prev_rf_on
        self._prev_rf_on = rf_on
        if prev is None or rf_on == prev:
            return
        if rf_on:
            reason = "operator"
            state = "on"
        else:
            state = "off"
            reasons = snapshot.get("fault_reasons") or []
            reason = f"fault: {'; '.join(reasons)}" if (
                snapshot.get("state") == "fault" and reasons) else "operator"
        self._link.notify(state=state, forward_w=float(t.get("forward_w", 0.0)),
                          reflected_fraction=float(t.get("reflected_fraction", 0.0)), reason=reason)
