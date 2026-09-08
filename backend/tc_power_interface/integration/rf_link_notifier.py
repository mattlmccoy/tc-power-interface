"""Notifies the FLIR link of RF on/off, from two sources that are deduplicated against each other:

- ``on_command`` — the operator/API commanded RF on/off (rf/enable, rf/disable, E-STOP). Sent
  IMMEDIATELY. Bench finding 2026-09-08: a quick on->off shorter than the 0.5 s telemetry poll was
  invisible to the edge detector, so FLIR never got the event; the command path closes that gap.
- ``on_snapshot`` — the observed rf_on edge in controller telemetry (attach as a Controller
  listener). Catches changes NOT made through our API (front panel) and protection trips; a falling
  edge that coincides with a FAULT carries the fault reasons.

Each RF state is announced once: whichever source sees it first wins, the other is suppressed.
"""
from __future__ import annotations

from typing import Any, Protocol


class _Link(Protocol):
    def notify(self, *, state: str, forward_w: float, reflected_fraction: float,
               reason: str) -> None: ...


class RfLinkNotifier:
    def __init__(self, link: _Link) -> None:
        self._link = link
        self._prev_rf_on: bool | None = None  # last OBSERVED telemetry state (edge baseline)
        self._notified: bool | None = None  # last state we TOLD FLIR about (dedupe)

    def on_command(self, *, on: bool, forward_w: float = 0.0, reflected_fraction: float = 0.0,
                   reason: str = "operator") -> None:
        """The API commanded RF on/off (and the generator accepted it): notify now, and remember it
        so the matching telemetry edge — if the sampler even catches it — is not sent twice."""
        self._emit(on, forward_w, reflected_fraction, reason=reason)

    def on_snapshot(self, snapshot: dict[str, Any]) -> None:
        t = snapshot.get("telemetry")
        if t is None:
            return
        rf_on = bool(t.get("rf_on"))
        prev = self._prev_rf_on
        self._prev_rf_on = rf_on
        if prev is None or rf_on == prev:
            return
        reason = "operator"
        if not rf_on:
            # On a protection trip the controller reads telemetry, then commands RF off and latches
            # FAULT; the falling rf_on edge therefore appears on the NEXT tick's snapshot, by which
            # time state=="fault" and fault_reasons are latched and still present here.
            reasons = snapshot.get("fault_reasons") or []
            if snapshot.get("state") == "fault" and reasons:
                reason = f"fault: {'; '.join(reasons)}"
        self._emit(rf_on, float(t.get("forward_w", 0.0)),
                   float(t.get("reflected_fraction", 0.0)), reason=reason)

    def _emit(self, on: bool, forward_w: float, reflected_fraction: float, *, reason: str) -> None:
        if self._notified is on:
            return  # this state was already announced (by the other source)
        self._notified = on
        self._link.notify(state="on" if on else "off", forward_w=forward_w,
                          reflected_fraction=reflected_fraction, reason=reason)
