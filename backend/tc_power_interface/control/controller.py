"""Supervisory controller: telemetry polling, control-lease keepalive, and protection.

Responsibilities (protection dominant):
- Poll telemetry on a background thread faster than the 2 s control lease; polling both feeds
  consumers and refreshes the lease.
- Apply the pure :func:`~tc_power_interface.control.safety.evaluate` verdict every sample and
  command RF **off** (latched FAULT) on any trip or telemetry read error.
- Gate the RF-enable path: RF can only be enabled while CONNECTED (never while FAULT).

This is the base for later match-tracking and thermal loops; those are intentionally NOT here.
The controller never enables RF on its own — only an explicit :meth:`enable_rf` call does.
"""

from __future__ import annotations

import enum
import threading
import time
from collections.abc import Callable
from typing import Any

from tc_power_interface.control.safety import SafetyDecision, SafetyLimits, evaluate
from tc_power_interface.device.base import Telemetry


class ControllerState(enum.Enum):
    DISCONNECTED = "disconnected"
    CONNECTED = "connected"
    FAULT = "fault"
    CLOSED = "closed"


class Controller:
    """Own the control lease, stream telemetry, and enforce protection."""

    def __init__(
        self,
        device: Any,
        limits: SafetyLimits | None = None,
        poll_interval_s: float = 0.5,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.device = device
        self.limits = limits or SafetyLimits()
        self.poll_interval_s = poll_interval_s
        self._clock = clock
        #: Backend name ("simulated"/"serial"), set by the app; the thermal loop's arming gate
        #: allows auto-drive freely in sim but requires an explicit arm on real hardware.
        self.backend = "simulated"

        self.state = ControllerState.DISCONNECTED
        self.latest_telemetry: Telemetry | None = None
        self.latest_decision: SafetyDecision | None = None
        self.fault_reasons: tuple[str, ...] = ()

        self._last_sample_monotonic: float | None = None
        self._lock = threading.Lock()  # guards published state
        self._io_lock = threading.Lock()  # serializes all transport access
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._listeners: list[Callable[[dict[str, Any]], None]] = []

    def add_listener(self, callback: Callable[[dict[str, Any]], None]) -> None:
        """Register a callback invoked with the snapshot dict after each poll cycle."""
        self._listeners.append(callback)

    def _notify(self) -> None:
        snap = self.snapshot()
        for cb in self._listeners:
            try:
                cb(snap)
            except Exception:  # noqa: BLE001 - a listener must never break the control loop
                pass

    # --- lifecycle -------------------------------------------------------------------------
    def connect(self) -> None:
        """Acquire the control lease and force MANUAL tuning (never the forbidden auto-tuner)."""
        with self._io_lock:
            granted = self.device.request_control()
        if not granted:
            raise RuntimeError("generator denied control request")
        # SAFETY: the built-in auto-tuner must never run — pin the tuner to manual up front.
        with self._io_lock:
            self.device.force_manual_mode()
        self.state = ControllerState.CONNECTED

    def identify(self) -> dict[str, Any]:
        """Return static device identity/limits (serialized against the poll loop)."""
        with self._io_lock:
            return dict(self.device.identify())

    def start(self) -> None:
        """Acquire control and begin background telemetry polling."""
        self.connect()
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="tcp-controller", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        """Stop polling, force RF off, and release control."""
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None
        try:
            with self._io_lock:
                self.device.set_rf(False)
                self.device.release_control()
        except Exception:  # noqa: BLE001 - best-effort safe shutdown
            pass
        self.state = ControllerState.CLOSED

    def _loop(self) -> None:
        while not self._stop.is_set():
            self._tick()
            self._stop.wait(self.poll_interval_s)

    # --- core poll cycle -------------------------------------------------------------------
    def _tick(self) -> None:
        """One telemetry+protection cycle. Safe to call directly (tests) or from the thread."""
        try:
            with self._io_lock:
                telemetry = self.device.read_telemetry()
        except Exception as exc:  # noqa: BLE001 - any read failure is a protection event
            self._enter_fault((f"telemetry read failed: {exc}",))
            self._notify()
            return

        now = self._clock()
        age = 0.0 if self._last_sample_monotonic is None else now - self._last_sample_monotonic
        self._last_sample_monotonic = now

        decision = evaluate(telemetry, self.limits, telemetry_age_s=age)
        with self._lock:
            self.latest_telemetry = telemetry
            self.latest_decision = decision
        if decision.trip:
            self._enter_fault(decision.reasons)
        self._notify()

    def _enter_fault(self, reasons: tuple[str, ...]) -> None:
        try:
            with self._io_lock:
                self.device.set_rf(False)
        except Exception:  # noqa: BLE001 - keep faulting even if the off-command itself fails
            pass
        with self._lock:
            self.state = ControllerState.FAULT
            self.fault_reasons = reasons

    def clear_fault(self) -> None:
        """Attempt to leave FAULT; only succeeds if the latest sample is not tripping."""
        with self._lock:
            if self.latest_decision is not None and not self.latest_decision.trip:
                self.state = ControllerState.CONNECTED
                self.fault_reasons = ()

    # --- guarded commands ------------------------------------------------------------------
    def enable_rf(self) -> None:
        if self.state is ControllerState.FAULT:
            raise RuntimeError(f"cannot enable RF while faulted: {'; '.join(self.fault_reasons)}")
        if self.state is not ControllerState.CONNECTED:
            raise RuntimeError(f"cannot enable RF in state {self.state.value}")
        with self._io_lock:
            self.device.set_rf(True)

    def disable_rf(self) -> None:
        with self._io_lock:
            self.device.set_rf(False)

    def set_setpoint(self, watts: int) -> int:
        clamped = self.limits.clamp_setpoint(watts)
        with self._io_lock:
            self.device.set_setpoint(clamped)
        return clamped

    def set_limits(self, limits: SafetyLimits) -> None:
        """Swap the protection limits live; ``evaluate`` reads ``self.limits`` each tick."""
        with self._lock:
            self.limits = limits

    def set_manual_mode(self, on: bool = True) -> None:
        """Force MANUAL tuning. ``on`` is accepted for API compatibility but always treated as True:
        there is no path to the forbidden automatic (ATUNE) mode."""
        with self._io_lock:
            self.device.force_manual_mode()

    def set_tune_capacity(self, percent: float) -> None:
        with self._io_lock:
            self.device.set_tune_capacity(percent)

    def set_load_capacity(self, percent: float) -> None:
        with self._io_lock:
            self.device.set_load_capacity(percent)

    # --- snapshot for the API --------------------------------------------------------------
    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            t = self.latest_telemetry
            d = self.latest_decision
        return {
            "state": self.state.value,
            "fault_reasons": list(self.fault_reasons),
            "telemetry": None
            if t is None
            else {
                "host_timestamp_ns": t.host_timestamp_ns,
                "forward_w": t.forward_w,
                "reverse_w": t.reverse_w,
                "load_w": t.load_w,
                "reflected_fraction": t.reflected_fraction,
                "rf_on": t.rf_on,
                "temperature_c": t.temperature_c,
                "operation_mode": t.operation_mode,
                "tuner": t.tuner,
                "status": int(t.status),
                "manual_mode": t.manual_mode,
                "tune_cap_percent": t.tune_cap_percent,
                "load_cap_percent": t.load_cap_percent,
                "dc_voltage": t.dc_voltage,
                "preset_slot": t.preset_slot,
            },
            "warnings": [] if d is None else list(d.warnings),
            "limits": {
                "max_forward_w": self.limits.max_forward_w,
                "max_reflected_w": self.limits.max_reflected_w,
                "temperature_c_trip": self.limits.temperature_c_trip,
                "reflected_fraction_warn": self.limits.reflected_fraction_warn,
                "forward_caution_w": self.limits.forward_caution_w,
                "forward_danger_w": self.limits.forward_danger_w,
            },
        }
