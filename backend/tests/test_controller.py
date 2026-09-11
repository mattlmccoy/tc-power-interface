"""Tests for the Controller: lease keepalive, protection application, guarded RF path.

Logic is tested by driving `_tick()` directly (no threads); one lifecycle test exercises the
real background thread against the simulator.
"""

import logging
import time
from dataclasses import replace

import pytest

from tc_power_interface.control.controller import Controller, ControllerState
from tc_power_interface.control.safety import SafetyLimits
from tc_power_interface.device.base import Telemetry
from tc_power_interface.device.cxn import CxnDevice
from tc_power_interface.device.simulated import SimulatedCxnTransport
from tc_power_interface.protocol.codec import Status


def make_controller(reflected_fraction=0.01, **limit_kw) -> Controller:
    device = CxnDevice(SimulatedCxnTransport(reflected_fraction=reflected_fraction))
    return Controller(device, limits=SafetyLimits(**limit_kw), poll_interval_s=0.01)


class TestConnect:
    def test_connect_acquires_control(self):
        c = make_controller()
        c.connect()
        assert c.state is ControllerState.CONNECTED

    def test_tick_populates_latest_telemetry(self):
        c = make_controller()
        c.connect()
        c._tick()
        assert c.latest_telemetry is not None
        assert c.latest_telemetry.forward_w == 0.0


class _ModeDevice:
    """Fake generator that reports a fixed manual_mode and records force_manual_mode calls, so we can
    prove connect() does NOT reset the caps (via force-manual) when the device is already manual."""

    def __init__(self, manual_mode: bool):
        self._manual = manual_mode
        self.forced = 0

    def request_control(self) -> bool:
        return True

    def force_manual_mode(self) -> None:
        self.forced += 1

    def read_telemetry(self) -> Telemetry:
        return replace(_benign_telemetry(), manual_mode=self._manual, tune_cap_percent=35.0, load_cap_percent=66.0)

    def set_rf(self, on: bool) -> None:
        pass

    def close(self) -> None:
        pass


class TestConnectPreservesCaps:
    def test_already_manual_does_not_force_manual(self):
        """The AG resets the cap DACs when told to enter manual mode; if it is ALREADY manual we must
        not send that command, or a hand-tuned AIT match would be wiped on connect."""
        dev = _ModeDevice(manual_mode=True)
        c = Controller(dev, poll_interval_s=0.01)
        c.connect()
        assert c.state is ControllerState.CONNECTED
        assert dev.forced == 0  # caps left exactly where they were

    def test_not_manual_forces_manual(self):
        """If the generator is NOT in manual (could be the forbidden ATUNE), we must force manual even
        though it resets the caps — the interlock wins over preserving a position."""
        dev = _ModeDevice(manual_mode=False)
        c = Controller(dev, poll_interval_s=0.01)
        c.connect()
        assert dev.forced == 1


class TestGuardedRf:
    def test_enable_rf_refused_before_connect(self):
        c = make_controller()
        with pytest.raises(RuntimeError):
            c.enable_rf()

    def test_enable_rf_then_telemetry_shows_rf_on(self):
        c = make_controller()
        c.connect()
        c.set_setpoint(150)
        c.enable_rf()
        c._tick()
        assert c.latest_telemetry.rf_on is True

    def test_disable_rf_always_allowed(self):
        c = make_controller()
        c.connect()
        c.disable_rf()  # should not raise even with RF already off
        c._tick()
        assert c.latest_telemetry.rf_on is False


class TestProtection:
    def test_high_reflection_trips_and_commands_rf_off(self):
        c = make_controller(reflected_fraction=0.5)
        c.connect()
        c.set_setpoint(150)
        c.enable_rf()
        c._tick()  # reads telemetry: reflected fraction 0.5 > 0.10 -> trip
        assert c.state is ControllerState.FAULT
        assert c.fault_reasons
        # RF was commanded off; a subsequent read confirms it
        c._tick()
        assert c.latest_telemetry.rf_on is False

    def test_enable_rf_refused_when_faulted(self):
        c = make_controller(reflected_fraction=0.5)
        c.connect()
        c.set_setpoint(150)
        c.enable_rf()
        c._tick()
        assert c.state is ControllerState.FAULT
        with pytest.raises(RuntimeError):
            c.enable_rf()

    def test_idle_link_loss_disconnects_not_faults(self):
        """Generator turned off / cable pulled while IDLE (RF off): after a short debounce the link
        is declared lost and the controller goes DISCONNECTED (re-attachable) — NOT a sticky FAULT.
        This is the reported bug: turning the generator off threw a fault that thought it was still
        connected."""
        dev = _FlakyDevice(rf_on=False)
        c = Controller(dev, poll_interval_s=0.01, link_loss_reads=3)
        c.connect()
        c._tick()  # one good read: latest sample shows RF off
        assert c.state is ControllerState.CONNECTED
        dev.fail = True
        c._tick()  # failure 1 — a single flaky read must NOT tear the link down
        assert c.state is ControllerState.CONNECTED
        c._tick()  # failure 2 — still within the debounce
        assert c.state is ControllerState.CONNECTED
        c._tick()  # failure 3 — link declared lost
        assert c.state is ControllerState.DISCONNECTED
        assert c.device is None  # torn down so it is cleanly re-attachable
        assert c.fault_reasons == ()  # no stuck fault to clear
        assert dev.rf_off_calls >= 1  # RF commanded off on the way down (defense in depth)

    def test_rf_on_link_loss_faults_immediately(self):
        """Losing the link while RF was ON is a protection event, not a benign disconnect: the
        generator may still be delivering power with no telemetry. Latch a loud FAULT at once (no
        debounce) and keep the device attached so the operator sees it and kills power."""
        dev = _FlakyDevice(rf_on=True)
        c = Controller(dev, poll_interval_s=0.01, link_loss_reads=3)
        c.connect()
        c._tick()  # good read: last known state is RF ON
        assert c.state is ControllerState.CONNECTED
        dev.fail = True
        c._tick()  # first failure while RF was on -> immediate FAULT
        assert c.state is ControllerState.FAULT
        assert any("RF was ON" in r for r in c.fault_reasons)
        assert c.device is not None  # NOT torn down — the loud fault must persist
        assert dev.rf_off_calls >= 1

    def test_transient_read_hiccup_recovers_without_disconnect(self):
        """A good read resets the debounce, so a flaky USB link that recovers never spuriously
        disconnects a healthy session."""
        dev = _FlakyDevice(rf_on=False)
        c = Controller(dev, poll_interval_s=0.01, link_loss_reads=3)
        c.connect()
        c._tick()
        dev.fail = True
        c._tick()
        c._tick()  # 2 consecutive failures (< 3)
        assert c.state is ControllerState.CONNECTED
        dev.fail = False
        c._tick()  # recovered — counter resets
        dev.fail = True
        c._tick()
        c._tick()  # only 2 failures since the recovery -> still connected
        assert c.state is ControllerState.CONNECTED

    def test_link_drop_fires_hook_to_halt_drivers(self):
        """On an idle link drop the controller fires ``on_link_dropped`` so the app can halt its
        drivers (ramp/timer/thermal), exactly as the manual Disconnect does."""
        dev = _FlakyDevice(rf_on=False)
        c = Controller(dev, poll_interval_s=0.01, link_loss_reads=1)
        halted = {"n": 0}
        c.on_link_dropped = lambda: halted.__setitem__("n", halted["n"] + 1)
        c.connect()
        c._tick()  # good read
        dev.fail = True
        c._tick()  # failure 1 == threshold -> drop
        assert c.state is ControllerState.DISCONNECTED
        assert halted["n"] == 1


class TestClearFault:
    """clear_fault() lets the operator leave a latched FAULT once the sample is healthy again — the
    UI's 'Clear fault' button. It refuses while a live trip condition still holds."""

    def test_clear_fault_succeeds_when_not_tripping(self):
        c = make_controller()  # benign sim (no trip)
        c.connect()
        c._tick()  # latest_decision is now non-tripping
        c._enter_fault(("transient stale",))  # latch a fault whose condition has since cleared
        assert c.state is ControllerState.FAULT
        assert c.clear_fault() is True
        assert c.state is ControllerState.CONNECTED
        assert c.fault_reasons == ()

    def test_clear_fault_refused_while_tripping(self):
        c = make_controller(reflected_fraction=0.5)  # high reflection -> real trip
        c.connect()
        c.set_setpoint(150)
        c.enable_rf()
        c._tick()  # trips: latest_decision.trip is True
        assert c.state is ControllerState.FAULT
        assert c.clear_fault() is False  # a live condition still holds it faulted
        assert c.state is ControllerState.FAULT

    def test_clear_fault_noop_when_not_faulted(self):
        c = make_controller()
        c.connect()
        c._tick()
        assert c.clear_fault() is True  # nothing to clear
        assert c.state is ControllerState.CONNECTED


def _benign_telemetry() -> Telemetry:
    """A sample that trips nothing on its own (RF off, cool, no status bits)."""
    return Telemetry(
        host_timestamp_ns=0,
        forward_w=0.0,
        reverse_w=0.0,
        load_w=0.0,
        reflected_fraction=0.0,
        status=Status(0),
        rf_on=False,
        temperature_c=25.0,
        operation_mode="",
        tuner="",
    )


class _FlakyDevice:
    """Fake generator whose reads succeed until ``.fail`` is set, then raise a ``TimeoutError`` (a
    lost link — generator off / cable pulled, mirroring ``SerialCxnTransport.read``). ``rf_on`` sets
    the last-known RF state so a test can drive the idle vs RF-on link-loss branches."""

    def __init__(self, rf_on: bool):
        self._rf_on = rf_on
        self.fail = False
        self.rf_off_calls = 0

    def request_control(self) -> bool:
        return True

    def force_manual_mode(self) -> None:
        pass

    def read_telemetry(self) -> Telemetry:
        if self.fail:
            raise TimeoutError("serial read timed out: got 0 of 1 bytes")
        return replace(_benign_telemetry(), rf_on=self._rf_on)

    def set_rf(self, on: bool) -> None:
        if on is False:
            self.rf_off_calls += 1

    def set_setpoint(self, w: int) -> None:
        pass

    def release_control(self) -> bool:
        return True

    def close(self) -> None:
        pass


class _SlowReadDevice:
    """Fake generator whose telemetry read consumes ``read_s`` of (fake) clock time — standing in
    for the real unit's three sequential CXN round-trips over the slow/flaky USB-serial link."""

    def __init__(self, holder: dict, read_s: float):
        self.holder = holder
        self.read_s = read_s
        self.rf_off_calls = 0

    def read_telemetry(self) -> Telemetry:
        self.holder["t"] += self.read_s  # the read itself takes wall-clock time
        return _benign_telemetry()

    def set_rf(self, on: bool) -> None:
        if on is False:
            self.rf_off_calls += 1


class TestStaleTelemetryWatchdog:
    """The staleness watchdog must trip on ABSENT telemetry (a stalled loop), NOT on telemetry that
    merely takes a while to READ. On the real generator a single read is three CXN round-trips and
    can take ~1 s; counting that against the timeout spuriously FAULTed on connect."""

    def test_slow_read_does_not_trip_stale_watchdog(self):
        holder = {"t": 0.0}
        # read takes 1.1 s and the poll interval is 0.5 s, so the cycle is 1.6 s (> the 1.5 s
        # timeout) — but the sample each tick is fresh, so this must NOT fault.
        dev = _SlowReadDevice(holder, read_s=1.1)
        c = Controller(
            dev,
            limits=SafetyLimits(telemetry_timeout_s=1.5),
            poll_interval_s=0.5,
            clock=lambda: holder["t"],
        )
        c._tick()  # first sample: age 0
        holder["t"] += 0.5  # the poll-interval wait between ticks
        c._tick()  # second sample: slow read, but fresh
        assert c.state is not ControllerState.FAULT
        assert dev.rf_off_calls == 0

    def test_single_stale_sample_does_not_trip_with_debounce(self):
        """A single stalled poll cycle (e.g. one slow disk flush) must NOT fault a healthy run —
        the staleness watchdog is debounced (default 2 consecutive stale reads)."""
        holder = {"t": 0.0}
        dev = _SlowReadDevice(holder, read_s=0.05)
        c = Controller(
            dev,
            limits=SafetyLimits(telemetry_timeout_s=1.5),
            poll_interval_s=0.5,
            clock=lambda: holder["t"],
        )
        c._tick()  # first sample: age 0
        holder["t"] += 2.0  # ONE stalled cycle
        c._tick()  # idle gap 2.0 s > 1.5 s, but only the 1st consecutive stale -> no fault
        assert c.state is not ControllerState.FAULT

    def test_sustained_stall_still_trips(self):
        """A genuinely sustained loss of telemetry still trips, after the debounce count."""
        holder = {"t": 0.0}
        dev = _SlowReadDevice(holder, read_s=0.05)  # fast reads
        c = Controller(
            dev,
            limits=SafetyLimits(telemetry_timeout_s=1.5),
            poll_interval_s=0.5,
            clock=lambda: holder["t"],
        )
        c._tick()  # first sample: age 0
        holder["t"] += 2.0
        c._tick()  # stale #1 -> no fault yet (debounced)
        assert c.state is not ControllerState.FAULT
        holder["t"] += 2.0
        c._tick()  # stale #2 (consecutive) -> genuine staleness trips
        assert c.state is ControllerState.FAULT
        assert any("stale" in r for r in c.fault_reasons)
        assert dev.rf_off_calls >= 1

    def test_stale_debounce_is_configurable_to_one(self):
        """stale_trip_reads=1 reproduces the original single-sample trip (no debounce)."""
        holder = {"t": 0.0}
        dev = _SlowReadDevice(holder, read_s=0.05)
        c = Controller(
            dev,
            limits=SafetyLimits(telemetry_timeout_s=1.5),
            poll_interval_s=0.5,
            clock=lambda: holder["t"],
            stale_trip_reads=1,
        )
        c._tick()
        holder["t"] += 2.0
        c._tick()  # first stale sample trips immediately when debounce is 1
        assert c.state is ControllerState.FAULT
        assert any("stale" in r for r in c.fault_reasons)

    def test_recovered_read_resets_stale_debounce(self):
        """One stale cycle followed by a healthy read must clear the debounce, so intermittent
        single hiccups never accumulate into a trip."""
        holder = {"t": 0.0}
        dev = _SlowReadDevice(holder, read_s=0.05)
        c = Controller(
            dev,
            limits=SafetyLimits(telemetry_timeout_s=1.5),
            poll_interval_s=0.5,
            clock=lambda: holder["t"],
        )
        c._tick()
        holder["t"] += 2.0
        c._tick()  # stale #1
        holder["t"] += 0.5
        c._tick()  # healthy gap (0.5 s) -> resets the counter
        holder["t"] += 2.0
        c._tick()  # stale #1 again (not #2) -> still no fault
        assert c.state is not ControllerState.FAULT


class TestListeners:
    def test_listener_receives_snapshot_each_tick(self):
        c = make_controller()
        c.connect()
        seen: list[dict] = []
        c.add_listener(seen.append)
        c._tick()
        assert len(seen) == 1
        assert seen[0]["telemetry"] is not None
        assert seen[0]["state"] == "connected"

    def test_raising_listener_is_isolated_and_logged(self, caplog):
        # A broken listener (recorder, FLIR notifier, ...) must never break the control loop or the
        # OTHER listeners — but it must not fail SILENTLY either: an operator has to be able to see
        # in the log that e.g. auto-logging stopped working.
        c = make_controller()
        c.connect()
        seen: list[dict] = []

        def bad(_snap: dict) -> None:
            raise RuntimeError("listener boom")

        c.add_listener(bad)
        c.add_listener(seen.append)  # registered AFTER the broken one
        with caplog.at_level(logging.ERROR, logger="tc_power_interface.control.controller"):
            c._tick()
        assert len(seen) == 1  # the later listener still ran
        errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
        assert errors, "the listener failure was swallowed without any log record"
        assert any("listener boom" in (r.exc_text or "") or "listener boom" in str(r.exc_info)
                   for r in errors)


class TestSetpointGuard:
    def test_setpoint_clamped_to_policy_ceiling(self):
        c = make_controller(max_forward_w=350)
        c.connect()
        c.set_setpoint(1000)
        c.enable_rf()
        c._tick()
        assert c.latest_telemetry.forward_w == 350.0


class TestLimitsUpdate:
    def test_set_limits_swaps_live(self):
        from tc_power_interface.control.safety import SafetyLimits

        c = make_controller()
        c.set_limits(SafetyLimits(max_forward_w=100))
        assert c.limits.max_forward_w == 100
        c.connect()
        assert c.set_setpoint(400) == 100  # clamp uses the new limit immediately

    def test_snapshot_limits_uses_new_field_names(self):
        c = make_controller()
        lim = c.snapshot()["limits"]
        assert set(lim) >= {
            "max_forward_w",
            "max_reflected_w",
            "temperature_c_trip",
            "reflected_fraction_warn",
        }


class TestLifecycle:
    def test_start_polls_in_background_then_stop_releases(self):
        transport = SimulatedCxnTransport()
        c = Controller(CxnDevice(transport), poll_interval_s=0.01)
        c.start()
        try:
            deadline = time.monotonic() + 2.0
            while c.latest_telemetry is None and time.monotonic() < deadline:
                time.sleep(0.01)
            assert c.latest_telemetry is not None
        finally:
            c.stop()
        assert c.state is ControllerState.CLOSED
        assert transport.control_granted is False  # released


class TestRuntimeAttachDetach:
    """The operator can boot with NO device (idle) and attach/detach one at runtime (connect UI)."""

    def test_idle_controller_is_disconnected_with_no_device(self):
        c = Controller(device=None, poll_interval_s=0.01)
        assert c.device is None
        assert c.state is ControllerState.DISCONNECTED
        assert c.snapshot()["telemetry"] is None  # no crash with no device

    def test_command_without_device_raises(self):
        c = Controller(device=None, poll_interval_s=0.01)
        with pytest.raises(RuntimeError):
            c.set_setpoint(100)
        with pytest.raises(RuntimeError):
            c.enable_rf()

    def test_attach_device_connects_and_polls(self):
        c = Controller(device=None, poll_interval_s=0.01)
        dev = CxnDevice(SimulatedCxnTransport())
        c.attach_device(dev, backend="serial")
        try:
            assert c.state is ControllerState.CONNECTED
            assert c.device is dev
            assert c.backend == "serial"
            deadline = time.monotonic() + 2.0
            while c.latest_telemetry is None and time.monotonic() < deadline:
                time.sleep(0.01)
            assert c.latest_telemetry is not None
        finally:
            c.detach_device()

    def test_detach_forces_rf_off_and_returns_to_disconnected(self):
        transport = SimulatedCxnTransport()
        dev = CxnDevice(transport)
        c = Controller(device=None, poll_interval_s=0.01)
        c.attach_device(dev)
        c.arm()  # runtime-connected devices start disarmed
        c.set_setpoint(150)
        c.enable_rf()
        c.detach_device()
        assert c.state is ControllerState.DISCONNECTED
        assert c.device is None
        assert transport.control_granted is False  # released
        assert dev.read_telemetry().rf_on is False  # RF commanded off on detach

    def test_reattach_after_detach_works(self):
        c = Controller(device=None, poll_interval_s=0.01)
        c.attach_device(CxnDevice(SimulatedCxnTransport()))
        c.detach_device()
        c.attach_device(CxnDevice(SimulatedCxnTransport()))  # second attach must not raise
        try:
            assert c.state is ControllerState.CONNECTED
        finally:
            c.detach_device()


class TestArm:
    """A runtime-connected device is read-only until ARMED. Arming takes control (no CLI probe)."""

    def test_boot_connected_is_armed(self):
        # The start()/direct-construction path stays armed (existing behaviour; tests unchanged).
        c = make_controller()
        assert c.armed is True

    def test_runtime_connect_starts_disarmed_and_blocks_control(self):
        c = Controller(device=None, poll_interval_s=0.01)
        c.attach_device(CxnDevice(SimulatedCxnTransport()))
        try:
            assert c.armed is False
            with pytest.raises(RuntimeError):
                c.set_setpoint(100)
            with pytest.raises(RuntimeError):
                c.enable_rf()
            with pytest.raises(RuntimeError):
                c.set_tune_capacity(50)
        finally:
            c.detach_device()

    def test_arm_enables_control_disarm_blocks_and_drops_rf(self):
        transport = SimulatedCxnTransport()
        c = Controller(device=None, poll_interval_s=0.01)
        c.attach_device(CxnDevice(transport))
        try:
            c.arm()
            assert c.armed is True
            c.set_setpoint(150)
            c.enable_rf()
            c._tick()
            assert c.latest_telemetry.rf_on is True
            c.disarm()
            assert c.armed is False
            c._tick()
            assert c.latest_telemetry.rf_on is False  # disarm drops RF
            with pytest.raises(RuntimeError):
                c.set_setpoint(50)  # control blocked again
        finally:
            c.detach_device()
