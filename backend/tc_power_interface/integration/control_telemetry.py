"""Per-tick control-telemetry POST to the FLIR run logger (``POST /api/control/telemetry``).

``build_control_telemetry`` is pure (maps the thermal snapshot + controller telemetry to the locked
contract keys). ``ControlTelemetryPoster`` is a best-effort, fire-and-forget sender (like
``FlirLink``): it never raises to the control loop and never blocks it; ``_post`` is injectable so
the send is unit-tested without HTTP.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from typing import Any


def build_control_telemetry(
    *, thermal: dict[str, Any], telemetry: dict[str, Any], roi: str, ts: str
) -> dict[str, Any]:
    """Map the thermal-loop snapshot + controller telemetry to the FLIR control-telemetry keys.

    Power is WATTS (the controller actuates in W). ``applied_w`` is ``None`` in advisory mode.
    """
    target_c = thermal["target_c"]
    measured_c = thermal["control_temp_c"]
    return {
        "ts": ts,
        "setpoint_c": target_c,
        "measured_c": measured_c,
        "applied_w": thermal.get("applied_w"),
        "recommended_w": thermal.get("recommended_w"),
        "phase": thermal.get("phase"),
        "mode": thermal.get("mode"),
        "armed": thermal.get("armed"),
        "forward_w": telemetry.get("forward_w", 0.0),
        "reverse_w": telemetry.get("reverse_w", 0.0),
        "reflected_fraction": telemetry.get("reflected_fraction", 0.0),
        "error_c": target_c - measured_c,
        "roi": roi,
    }


def build_power_heartbeat(*, telemetry: dict[str, Any], ts: str) -> dict[str, Any]:
    """Power-only row for a MANUAL RF run (thermal loop stopped, generator connected).

    Same endpoint as the closed-loop row; ``mode`` is ``"manual"`` and the thermal keys are
    deliberately omitted, so FLIR labels it "RF: <W>" (not a loop sample), stays "engaged" (its
    RF UI persists while the generator is connected), and logs an RF-power trace for EVERY run.
    """
    return {
        "ts": ts,
        "mode": "manual",
        "forward_w": telemetry.get("forward_w", 0.0),
        "reverse_w": telemetry.get("reverse_w", 0.0),
        "reflected_fraction": telemetry.get("reflected_fraction", 0.0),
    }


class HeartbeatGate:
    """Admit at most one heartbeat per ``period_s``. The controller polls at 2 Hz; ~1 Hz is plenty
    for FLIR's engaged-check (10 s) and its trace. Self-clocking (monotonic) unless ``now`` is given
    (tests)."""

    def __init__(self, period_s: float = 1.0) -> None:
        self.period_s = period_s
        self._last: float | None = None

    def due(self, *, now: float | None = None) -> bool:
        t = time.monotonic() if now is None else now
        if self._last is not None and t - self._last < self.period_s:
            return False
        self._last = t
        return True


def _http_post(url: str, body: dict[str, Any], timeout: float) -> None:
    import httpx

    httpx.post(url, json=body, timeout=timeout).raise_for_status()


class ControlTelemetryPoster:
    """Fire-and-forget POST of a control-telemetry body per tick to ``{url}/api/control/telemetry``.

    A no-op when disabled or without a url. Failures are swallowed into ``last_result`` and never
    propagate to the control loop.
    """

    def __init__(
        self,
        url: str,
        *,
        enabled: bool,
        timeout: float = 0.5,
        _post: Callable[[str, dict[str, Any], float], None] = _http_post,
    ) -> None:
        self.url = url.rstrip("/")
        self.enabled = enabled
        self.timeout = timeout
        self._post = _post
        self._threads: list[threading.Thread] = []
        self.last_result: dict[str, Any] = {"ok": None, "message": "", "ts": 0.0}

    def post(self, body: dict[str, Any]) -> None:
        if not self.enabled or not self.url:
            return
        self._threads = [t for t in self._threads if t.is_alive()]  # drop finished sends
        t = threading.Thread(target=self._send, args=(body,), daemon=True)
        self._threads.append(t)
        t.start()

    def _send(self, body: dict[str, Any]) -> None:
        try:
            self._post(f"{self.url}/api/control/telemetry", body, self.timeout)
            self.last_result = {"ok": True, "message": "", "ts": time.time()}
        except Exception as exc:  # noqa: BLE001 - best-effort; never propagate to the control loop
            self.last_result = {"ok": False, "message": str(exc), "ts": time.time()}

    def join(self, timeout: float = 2.0) -> None:
        for t in list(self._threads):
            t.join(timeout)
