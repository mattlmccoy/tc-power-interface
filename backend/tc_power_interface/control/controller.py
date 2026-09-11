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
import logging
import threading
import time
from collections.abc import Callable
from typing import Any

from tc_power_interface.control.safety import SafetyDecision, SafetyLimits, evaluate
from tc_power_interface.device.base import Telemetry

logger = logging.getLogger(__name__)


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
        link_loss_reads: int = 3,
        stale_trip_reads: int = 2,
    ) -> None:
        self.device = device
        self.limits = limits or SafetyLimits()
        self.poll_interval_s = poll_interval_s
        self._clock = clock
        #: Consecutive failed telemetry reads that mean "the link is gone" (generator off / cable
        #: pulled) while IDLE — debounces a single flaky USB read before tearing the link down. The
        #: RF-ON case never waits for this: it faults on the first failure (protection).
        self.link_loss_reads = link_loss_reads
        self._read_failures = 0
        #: Consecutive LATE-but-successful reads (idle gap > telemetry_timeout_s) needed before the
        #: staleness watchdog faults. Debounces a single stalled poll cycle (e.g. a disk/flush
        #: hiccup) so it never faults a healthy run; 1 restores the original trip-on-first behavior.
        self.stale_trip_reads = stale_trip_reads
        self._stale_ticks = 0
        #: Optional hook the app wires to halt its drivers (ramp/timer/thermal/tuner) when the
        #: controller auto-drops a lost link — the driver objects live in the API layer, so the
        #: controller cannot reach them directly. Mirrors what POST /api/disconnect does manually.
        self.on_link_dropped: Callable[[], None] | None = None
        #: Backend name ("simulated"/"serial"), set by the app; the thermal loop's arming gate
        #: allows auto-drive freely in sim but requires an explicit arm on real hardware.
        self.backend = "simulated"
        #: Global control ARM gate. A runtime-connected device (attach_device) starts DISARMED —
        #: read-only telemetry, all control commands refused — until arm() is called (the UI's ARM
        #: button; replaces the read-only CLI probe). The boot/start() path stays armed so existing
        #: flows and tests are unchanged. disarm() drops RF and re-locks control.
        self.armed = True

        #: VNA pre-run auto-tune interlock. While a VNA session is active the matching network is
        #: being tuned against a NanoVNA with RF OFF, so enable_rf() must be REFUSED (fail safe).
        #: Only end_vna_session() clears it; a stale heartbeat is reported but never clears it, and
        #: disable_rf()/estop()/disarm() are never gated by it (RF-off / E-STOP always allowed).
        self._vna_session_active = False
        self._vna_hb_ns: int | None = None
        self._vna_stale_s = 10.0

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
            except Exception:  # noqa: BLE001 - a listener must never break the control loop ...
                # ... but it must not fail SILENTLY either: a broken recorder/notifier has to be
                # visible in the operator log, not swallowed forever.
                logger.exception("controller listener %r failed", getattr(cb, "__qualname__", cb))

    # --- lifecycle -------------------------------------------------------------------------
    def connect(self) -> None:
        """Acquire the control lease and ensure MANUAL tuning (never the forbidden auto-tuner) — WITHOUT
        disturbing the cap positions. Sending the manual-mode command resets the AG 0613's cap DACs,
        which would wipe a hand-tuned AIT match, so only force it when the generator is NOT already in
        manual mode. If it already is, it is safe and we leave the caps exactly where they are. If the
        mode cannot be read, force it (never risk a live ATUNE)."""
        with self._io_lock:
            granted = self.device.request_control()
        if not granted:
            raise RuntimeError("generator denied control request")
        # SAFETY: the built-in auto-tuner must never run. Forcing manual mode guarantees that, but it
        # also zeroes the caps — so only do it if we can't confirm the generator is already manual.
        already_manual = False
        with self._io_lock:
            try:
                already_manual = bool(self.device.read_telemetry().manual_mode)
            except Exception:  # noqa: BLE001 - unreadable mode -> force manual below, never risk ATUNE
                already_manual = False
        if not already_manual:
            with self._io_lock:
                self.device.force_manual_mode()  # only when needed; this resets the caps
        self.state = ControllerState.CONNECTED

    def identify(self) -> dict[str, Any]:
        """Return static device identity/limits (serialized against the poll loop)."""
        with self._io_lock:
            return dict(self.device.identify())

    def _start_polling(self) -> None:
        self._stop.clear()
        self._thread = threading.Thread(target=self._loop, name="tcp-controller", daemon=True)
        self._thread.start()

    def _stop_polling(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None

    def _safe_shutdown_device(self) -> None:
        """Best-effort: command RF off and release the control lease on the current device."""
        try:
            with self._io_lock:
                if self.device is not None:
                    self.device.set_rf(False)
                    self.device.release_control()
        except Exception:  # noqa: BLE001 - best-effort safe shutdown
            pass

    def start(self) -> None:
        """Acquire control and begin background telemetry polling."""
        self.connect()
        self._start_polling()

    def stop(self) -> None:
        """Stop polling, force RF off, and release control."""
        self._stop_polling()
        self._safe_shutdown_device()
        self.state = ControllerState.CLOSED

    # --- runtime device attach/detach (connect UI) -----------------------------------------
    def attach_device(self, device: Any, backend: str | None = None) -> None:
        """Attach a device at runtime and begin polling. Used by the connect UI; the operator can
        boot idle (device=None) and attach a real generator (or the simulator) on demand. Detaches
        any current device first so re-connecting is safe. Never enables RF."""
        if self.device is not None:
            self.detach_device()
        if backend is not None:
            self.backend = backend
        self.device = device
        try:
            self.connect()  # request control + force MANUAL (never ATUNE) -> CONNECTED
        except Exception:
            # Connect failed (denied control, dead port): close the just-opened device and return to
            # idle so a serial port is freed and the operator keeps serving. Re-raise to the caller.
            try:
                self.device.close()
            except Exception:  # noqa: BLE001
                pass
            with self._lock:
                self.device = None
                self.state = ControllerState.DISCONNECTED
            raise
        self.armed = False  # runtime-connected devices are read-only until explicitly ARMED
        self._start_polling()

    def arm(self) -> None:
        """Take control of a connected device (enables the control commands). Only from CONNECTED —
        clear any fault first. Never enables RF; it only unlocks the control path."""
        if self.state is not ControllerState.CONNECTED:
            raise RuntimeError(f"cannot arm in state {self.state.value}")
        self.armed = True

    def disarm(self) -> None:
        """Drop control: force RF off and re-lock the control commands. Always allowed."""
        self.armed = False
        try:
            with self._io_lock:
                if self.device is not None:
                    self.device.set_rf(False)
        except Exception:  # noqa: BLE001 - best-effort RF-off on disarm
            pass

    def _require_armed(self) -> None:
        if not self.armed:
            raise RuntimeError("not armed — press ARM to take control of the device")

    def estop(self) -> None:
        """Emergency stop: force RF off and setpoint 0 on the device (BYPASSING the arm gate) and
        disarm. Best-effort and safe in any state (no device / disarmed / faulted) — it must never
        be blocked by a gate."""
        with self._io_lock:
            dev = self.device
            if dev is not None:
                try:
                    dev.set_rf(False)
                except Exception:  # noqa: BLE001
                    pass
                try:
                    dev.set_setpoint(0)
                except Exception:  # noqa: BLE001
                    pass
        self.armed = False

    def detach_device(self) -> None:
        """Stop polling, force RF off, release the lease, close the transport, and go DISCONNECTED
        (re-attachable — unlike ``stop()`` which is terminal). Safe to call when already idle."""
        self._stop_polling()
        self._safe_shutdown_device()
        try:
            if self.device is not None:
                self.device.close()
        except Exception:  # noqa: BLE001 - best-effort close; frees a serial port for reconnect
            pass
        with self._lock:
            self.device = None
            self.armed = False
            self.state = ControllerState.DISCONNECTED
            self.latest_telemetry = None
            self.latest_decision = None
            self.fault_reasons = ()
        self._last_sample_monotonic = None

    def _require_device(self) -> None:
        if self.device is None:
            raise RuntimeError("no device connected")

    def _loop(self) -> None:
        while not self._stop.is_set():
            self._tick()
            self._stop.wait(self.poll_interval_s)

    # --- core poll cycle -------------------------------------------------------------------
    def _tick(self) -> None:
        """One telemetry+protection cycle. Safe to call directly (tests) or from the thread."""
        read_start = self._clock()
        try:
            with self._io_lock:
                telemetry = self.device.read_telemetry()
        except Exception as exc:  # noqa: BLE001 - a read failure is a lost link, or (RF-on) a protection event
            self._on_read_failure(exc)
            self._notify()
            return
        self._read_failures = 0  # a good read clears the link-loss debounce

        # Staleness = the IDLE GAP between reads (a stalled/starved poll loop), NOT the duration of
        # the read itself. A single real read is three sequential CXN round-trips over a slow, flaky
        # USB-serial link and can take ~1 s; measuring age from the read's COMPLETION counted that
        # duration against the timeout and spuriously FAULTed ("telemetry stale") right after
        # connect, even though the sample just read is fresh. So age spans the previous read's
        # completion -> this read's start; a genuinely stalled loop still trips.
        last = self._last_sample_monotonic
        age = 0.0 if last is None else read_start - last
        self._last_sample_monotonic = self._clock()  # this read's completion time

        # Staleness is owned HERE, not in evaluate(), so it can be DEBOUNCED: a single stalled poll
        # cycle (e.g. a slow disk flush from the recorder) must not fault a healthy run — only a
        # SUSTAINED loss trips. evaluate() is given age 0 so it judges only the instantaneous safety
        # conditions (reflected power, temperature, status bits), which always trip on the first bad
        # sample; the staleness reason is added here after stale_trip_reads consecutive late reads.
        base = evaluate(telemetry, self.limits, telemetry_age_s=0.0)
        if age > self.limits.telemetry_timeout_s:
            self._stale_ticks += 1
        else:
            self._stale_ticks = 0
        reasons = list(base.reasons)
        if self._stale_ticks >= self.stale_trip_reads:
            reasons.append(
                f"telemetry stale/timeout ({age:.2f}s > {self.limits.telemetry_timeout_s:.2f}s)"
            )
        decision = SafetyDecision(
            trip=bool(reasons), reasons=tuple(reasons), warnings=base.warnings
        )
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

    def clear_fault(self) -> bool:
        """Leave FAULT if the latest sample is no longer tripping (the UI's 'Clear fault' button).
        Returns True if the controller is not (or no longer) faulted; False if a live trip condition
        still holds it in FAULT. RF stays off — the operator re-enables it explicitly."""
        with self._lock:
            if self.state is not ControllerState.FAULT:
                return True
            if self.latest_decision is not None and not self.latest_decision.trip:
                self.state = ControllerState.CONNECTED
                self.fault_reasons = ()
                return True
            return False

    def _on_read_failure(self, exc: Exception) -> None:
        """Classify a telemetry read failure — the fix for a turned-off generator latching a stuck
        FAULT. If the last known sample had RF ON, the generator may still be delivering power with
        no telemetry: latch a loud FAULT at once (protection; no debounce). Otherwise it is a benign
        lost link (generator off / cable pulled) — debounce one flaky read, then go DISCONNECTED so
        the UI shows the truth and the state is cleanly re-attachable, not a fault that can never be
        cleared while reads keep failing."""
        self._read_failures += 1
        last = self.latest_telemetry
        if last is not None and last.rf_on:
            self._enter_fault(
                (
                    "link lost while RF was ON — the generator may still be live; "
                    f"kill power at the console ({exc})",
                )
            )
            return
        if self._read_failures >= self.link_loss_reads:
            self._drop_link()

    def _drop_link(self) -> None:
        """Tear down a lost link from INSIDE the poll loop and return to DISCONNECTED (re-attachable
        for a reconnect). Signals the loop to stop — it runs ON this thread, so it must NEVER join
        itself the way
        :meth:`detach_device` does — then forces RF off and closes the transport best-effort and
        clears published state. Finally fires :attr:`on_link_dropped` (outside the locks) so the app
        halts its drivers, matching the manual Disconnect path."""
        self._stop.set()  # let _loop() exit after this tick; do not join our own thread
        with self._io_lock:
            dev = self.device
            if dev is not None:
                try:
                    dev.set_rf(False)
                except Exception:  # noqa: BLE001 - best-effort RF-off; the link is already gone
                    pass
                try:
                    dev.close()
                except Exception:  # noqa: BLE001 - best-effort close; frees the port for reconnect
                    pass
        with self._lock:
            self.device = None
            self.armed = False
            self.state = ControllerState.DISCONNECTED
            self.latest_telemetry = None
            self.latest_decision = None
            self.fault_reasons = ()
        self._last_sample_monotonic = None
        self._read_failures = 0
        hook = self.on_link_dropped
        if hook is not None:
            try:
                hook()
            except Exception:  # noqa: BLE001 - a driver-halt hook must never break link teardown
                logger.exception("on_link_dropped hook failed")

    # --- guarded commands ------------------------------------------------------------------
    def enable_rf(self) -> None:
        # SAFETY: VNA-session interlock is the FIRST gate — refuse RF before any arm/state check
        # while the matching network is being tuned against a NanoVNA with RF off. Fail safe.
        if self._vna_session_active:
            raise RuntimeError("VNA mode — RF disabled")
        self._require_armed()
        if self.state is ControllerState.FAULT:
            raise RuntimeError(f"cannot enable RF while faulted: {'; '.join(self.fault_reasons)}")
        if self.state is not ControllerState.CONNECTED:
            raise RuntimeError(f"cannot enable RF in state {self.state.value}")
        with self._io_lock:
            self.device.set_rf(True)

    def disable_rf(self) -> None:
        self._require_device()
        with self._io_lock:
            self.device.set_rf(False)

    def set_setpoint(self, watts: int) -> int:
        self._require_device()
        self._require_armed()
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
        self._require_device()
        self._require_armed()
        with self._io_lock:
            self.device.set_tune_capacity(percent)

    def set_load_capacity(self, percent: float) -> None:
        self._require_device()
        self._require_armed()
        with self._io_lock:
            self.device.set_load_capacity(percent)

    # --- VNA pre-run auto-tune session (RF interlock) --------------------------------------
    def begin_vna_session(self) -> None:
        """Enter VNA-tune mode: RF is refused until end_vna_session(). Forces RF off best-effort
        (defense in depth); the disable is ignored when no device is attached so begin never
        raises. E-STOP / RF-OFF stay available throughout."""
        with self._lock:
            self._vna_session_active = True
            self._vna_hb_ns = time.monotonic_ns()
        try:
            self.disable_rf()  # defense in depth; ignored if no device
        except Exception:  # noqa: BLE001 - best-effort RF-off; no-device must not raise
            pass

    def end_vna_session(self) -> None:
        """Leave VNA-tune mode. RF is allowed again (arm/connected/not-faulted gates still apply).
        Never enables RF itself."""
        with self._lock:
            self._vna_session_active = False
            self._vna_hb_ns = None

    def vna_heartbeat(self) -> None:
        """Refresh the VNA-session liveness timestamp. A missing/stale heartbeat is REPORTED in the
        snapshot but never clears the session — only end_vna_session() does."""
        with self._lock:
            if self._vna_session_active:
                self._vna_hb_ns = time.monotonic_ns()

    # --- snapshot for the API --------------------------------------------------------------
    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            t = self.latest_telemetry
            d = self.latest_decision
            vna_active = self._vna_session_active
            vna_hb_ns = self._vna_hb_ns
        age_s = None if vna_hb_ns is None else (time.monotonic_ns() - vna_hb_ns) / 1e9
        return {
            "state": self.state.value,
            "armed": self.armed,
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
            "vna_session": {
                "active": vna_active,
                "stale": bool(vna_active and age_s is not None and age_s > self._vna_stale_s),
                "age_s": age_s,
            },
            "limits": {
                "max_forward_w": self.limits.max_forward_w,
                "max_reflected_w": self.limits.max_reflected_w,
                "temperature_c_trip": self.limits.temperature_c_trip,
                "reflected_fraction_warn": self.limits.reflected_fraction_warn,
                "forward_caution_w": self.limits.forward_caution_w,
                "forward_danger_w": self.limits.forward_danger_w,
            },
        }
