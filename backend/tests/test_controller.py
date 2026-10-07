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
from tc_power_interface.protocol.codec import GtBlock, InvalidStatusWord, Status


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
    """Fake generator that reports a fixed manual_mode and records force_manual_mode calls, so we
    can
    prove connect() does NOT reset the caps (via force-manual) when the device is already manual."""

    def __init__(self, manual_mode: bool):
        self._manual = manual_mode
        self.forced = 0

    def request_control(self) -> bool:
        return True

    def force_manual_mode(self) -> None:
        self.forced += 1

    def read_telemetry(self) -> Telemetry:
        return replace(
            _benign_telemetry(),
            manual_mode=self._manual,
            tune_cap_percent=35.0,
            load_cap_percent=66.0,
        )

    def read_match(self) -> GtBlock:
        return GtBlock(manual_mode=self._manual, load_capacity=66.0, tune_capacity=35.0,
                       dc_voltage=0, preset_slot=0)

    def set_rf(self, on: bool) -> None:
        pass

    def close(self) -> None:
        pass


class TestConnectPreservesCaps:
    def test_already_manual_does_not_force_manual(self):
        """The AG resets the cap DACs when told to enter manual mode; if it is ALREADY manual we
        must
        not send that command, or a hand-tuned AIT match would be wiped on connect."""
        dev = _ModeDevice(manual_mode=True)
        c = Controller(dev, poll_interval_s=0.01)
        c.connect()
        assert c.state is ControllerState.CONNECTED
        assert dev.forced == 0  # caps left exactly where they were

    def test_not_manual_forces_manual(self):
        """If the generator is NOT in manual (could be the forbidden ATUNE), we must force manual
        even
        though it resets the caps — the interlock wins over preserving a position."""
        dev = _ModeDevice(manual_mode=False)
        c = Controller(dev, poll_interval_s=0.01)
        c.connect()
        assert dev.forced == 1


class _GarbledGsModeDevice(_ModeDevice):
    """_ModeDevice whose GS status word is ALWAYS garbled (read_telemetry raises InvalidStatusWord)
    while the GT/match block still reads fine — or, with ``gt_error``, the GT read fails too."""

    def __init__(self, manual_mode: bool, gt_error: Exception | None = None):
        super().__init__(manual_mode)
        self.gt_error = gt_error
        self.gt_reads = 0

    def read_telemetry(self) -> Telemetry:
        raise _invalid_word()

    def read_match(self) -> GtBlock:
        self.gt_reads += 1
        if self.gt_error is not None:
            raise self.gt_error
        return super().read_match()


class TestConnectReadsManualModeFromGt:
    """connect() takes manual mode from the GT/match block only, so a garbled GS status word can
    never be mistaken for 'mode unreadable' (which forces manual and RESETS the AIT cap DACs)."""

    def test_garbled_gs_with_gt_manual_does_not_force_manual(self):
        dev = _GarbledGsModeDevice(manual_mode=True)
        c = Controller(dev, poll_interval_s=0.01)
        c.connect()
        assert c.state is ControllerState.CONNECTED
        assert dev.forced == 0  # hand-tuned caps kept
        assert dev.gt_reads == 1

    def test_gt_not_manual_still_forces_manual(self):
        dev = _GarbledGsModeDevice(manual_mode=False)
        c = Controller(dev, poll_interval_s=0.01)
        c.connect()
        assert dev.forced == 1

    def test_gt_read_failure_keeps_the_force_manual_fallback(self):
        dev = _GarbledGsModeDevice(manual_mode=True, gt_error=TimeoutError("no reply"))
        c = Controller(dev, poll_interval_s=0.01)
        c.connect()
        assert dev.gt_reads == 1  # one read, no retry loop
        assert dev.forced == 1  # unchanged fallback: unreadable mode -> force manual
        assert c.state is ControllerState.CONNECTED


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


class TestCapCommandEvents:
    """Every tune/load cap command fires on_cap_command (the app records it as a run event) with its
    source, the requested value, the readback just before, and the RF context — so a run can be
    reconstructed after the fact (a 2026-09-24 in-run Load retune preceded a transformer-core
    runaway, and nothing recorded which cap moves came when)."""

    def test_event_carries_source_request_readback_before_and_rf_context(self):
        c = make_controller()
        c.connect()
        c._tick()  # latest sample -> readback_before
        before = c.latest_telemetry.load_cap_percent
        seen: list[dict] = []
        c.on_cap_command = seen.append
        c.set_load_capacity(40.0, source="operator")
        assert len(seen) == 1
        ev = seen[0]
        assert ev["axis"] == "load"
        assert ev["source"] == "operator"
        assert ev["requested"] == 40.0
        assert ev["readback_before"] == before
        assert ev["rf_on"] is False
        assert "forward_w" in ev and "reverse_w" in ev

    def test_source_defaults_to_unspecified(self):
        c = make_controller()
        c.connect()
        c._tick()
        seen: list[dict] = []
        c.on_cap_command = seen.append
        c.set_tune_capacity(20.0)
        assert seen[0]["axis"] == "tune"
        assert seen[0]["source"] == "unspecified"

    def test_refused_command_records_nothing(self):
        c = make_controller()
        c.connect()
        c.disarm()
        seen: list[dict] = []
        c.on_cap_command = seen.append
        with pytest.raises(RuntimeError):
            c.set_tune_capacity(10.0, source="operator")
        assert seen == []

    def test_hook_failure_never_breaks_the_command(self):
        c = make_controller()
        c.connect()
        c._tick()

        def boom(_ev: dict) -> None:
            raise RuntimeError("recorder down")

        c.on_cap_command = boom
        c.set_tune_capacity(33.0, source="operator")  # must not raise
        c._tick()
        assert c.latest_telemetry.tune_cap_percent == pytest.approx(33.0, abs=1.0)


class TestCommandedSetpoint:
    """The recorder needs the requested power (spec section 3.4). Front-panel changes are not seen,
    so the field says what it is: the last setpoint TC-POWER commanded (None until one is sent)."""

    def test_snapshot_reports_the_last_commanded_setpoint(self, tmp_path):
        from fastapi.testclient import TestClient

        from tc_power_interface.api.app import create_app

        app = create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path)
        with TestClient(app) as c:
            ctrl = c.app.state.controller
            assert ctrl.snapshot()["commanded_setpoint_w"] is None  # unknown, not 0
            assert c.post("/api/arm").status_code == 200
            c.post("/api/setpoint", json={"watts": 42})
            assert ctrl.snapshot()["commanded_setpoint_w"] == 42
            c.post("/api/estop")
            assert ctrl.snapshot()["commanded_setpoint_w"] == 0

    def test_snapshot_reports_the_clamped_value(self):
        c = make_controller(max_forward_w=50)
        c.connect()
        c.arm()
        applied = c.set_setpoint(500)
        assert applied < 500
        assert c.snapshot()["commanded_setpoint_w"] == applied

    def test_refused_setpoint_leaves_it_unchanged(self):
        c = make_controller()
        c.connect()
        c.arm()
        c.set_setpoint(30)
        c.disarm()
        with pytest.raises(RuntimeError):
            c.set_setpoint(60)
        assert c.snapshot()["commanded_setpoint_w"] == 30

    def test_failed_estop_write_does_not_claim_zero(self):
        c = make_controller()
        c.connect()
        c.arm()
        c.set_setpoint(30)

        def boom(_w: int) -> None:
            raise RuntimeError("link down")

        c.device.set_setpoint = boom  # type: ignore[method-assign]
        c.estop()  # best-effort: must not raise
        assert c.snapshot()["commanded_setpoint_w"] == 30

    def test_detach_forgets_it(self):
        c = make_controller()
        c.connect()
        c.arm()
        c.set_setpoint(30)
        c.detach_device()
        assert c.snapshot()["commanded_setpoint_w"] is None

    def test_link_loss_forgets_it(self):
        c = make_controller()
        c.connect()
        c.arm()
        c.set_setpoint(30)
        c._drop_link()
        assert c.snapshot()["commanded_setpoint_w"] is None

    def test_any_new_device_starts_unknown(self):
        c = make_controller()
        c.connect()
        c.arm()
        c.set_setpoint(30)
        c._drop_link()
        c._last_setpoint_w = 30  # stale value left by any path that skipped the reset
        c.attach_device(CxnDevice(SimulatedCxnTransport()))
        try:
            assert c.snapshot()["commanded_setpoint_w"] is None
        finally:
            c.detach_device()

    def test_both_snapshot_keys_report_the_same_value(self):
        # Merge of main's scope `last_setpoint_w` with the cockpit's `commanded_setpoint_w`: one
        # underlying value, two consumer-facing names; they must never disagree.
        c = make_controller()
        c.connect()
        assert c.snapshot()["last_setpoint_w"] is c.snapshot()["commanded_setpoint_w"] is None
        c.arm()
        c.set_setpoint(30)
        snap = c.snapshot()
        assert snap["last_setpoint_w"] == snap["commanded_setpoint_w"] == 30
        c.estop()
        snap = c.snapshot()
        assert snap["last_setpoint_w"] == snap["commanded_setpoint_w"] == 0
class _ScriptedDevice:
    """Fake generator that plays a script of reads: each entry is a Telemetry (good read) or an
    Exception instance (raised). Models the 2026-10-07 incident: one checksum-valid GS frame whose
    status word was 0xFFFF between good reads."""

    def __init__(self, script: list):
        self.script = list(script)
        self.rf_off_calls = 0

    def request_control(self) -> bool:
        return True

    def force_manual_mode(self) -> None:
        pass

    def read_telemetry(self) -> Telemetry:
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def set_rf(self, on: bool) -> None:
        if on is False:
            self.rf_off_calls += 1

    def set_setpoint(self, w: int) -> None:
        pass

    def release_control(self) -> bool:
        return True

    def close(self) -> None:
        pass


def _invalid_word(forward_w: float = 0.0, reverse_w: float = 0.0,
                  temperature_c: float = 23.0) -> Exception:
    """The 2026-10-07 frame: status 0xFFFF; same-frame temperature 23.0 C, forward 0 W."""
    return InvalidStatusWord(
        "status word 0xFFFF has undefined bits", raw_word=0xFFFF, forward_w=forward_w,
        reverse_w=reverse_w, temperature_c=temperature_c,
    )


def _connected(script: list, **kw) -> tuple[Controller, _ScriptedDevice]:
    dev = _ScriptedDevice(script)
    c = Controller(dev, poll_interval_s=0.01, link_loss_reads=3, **kw)
    c.state = ControllerState.CONNECTED  # skip connect()'s own read; script is poll reads only
    return c, dev


class TestInvalidStatusWord:
    """A status word with undefined bits (the real 0xFFFF of 2026-10-07) is a glitch the FIRST time
    (discarded: no fault, no fake sample, no link-loss count) and a broken link if it PERSISTS
    (second consecutive one is handled exactly like a read failure)."""

    def test_single_invalid_word_is_discarded_without_fault(self, caplog):
        good1 = replace(_benign_telemetry(), temperature_c=23.0, host_timestamp_ns=1)
        good2 = replace(_benign_telemetry(), temperature_c=23.0, host_timestamp_ns=2)
        c, dev = _connected([good1, _invalid_word(), good2])
        seen: list[dict] = []
        c.add_listener(seen.append)
        c._tick()  # good
        decision_before = c.latest_decision
        with caplog.at_level(logging.WARNING, logger="tc_power_interface.control.controller"):
            c._tick()  # the 0xFFFF glitch
        assert c.state is ControllerState.CONNECTED
        assert c.fault_reasons == ()
        assert c.latest_telemetry is good1  # previous good sample kept, no fake one published
        assert c.latest_decision is decision_before
        assert c._read_failures == 0  # not counted toward link loss
        assert len(seen) == 1  # listeners NOT notified for the discarded read
        assert dev.rf_off_calls == 0
        warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
        assert any("0xFFFF" in r.getMessage() for r in warnings)
        c._tick()  # good again
        assert c.latest_telemetry is good2
        assert len(seen) == 2  # notified only for the two good samples
        assert c.state is ControllerState.CONNECTED

    def test_good_read_resets_the_invalid_count(self):
        g = _benign_telemetry()
        c, _ = _connected([g, _invalid_word(), g, _invalid_word(), g])
        for _ in range(5):
            c._tick()
        assert c.state is ControllerState.CONNECTED
        assert c._read_failures == 0
        assert c._invalid_status_reads == 0

    def test_two_consecutive_invalid_words_with_rf_on_fault(self):
        on = replace(_benign_telemetry(), rf_on=True, status=Status.RF_ENABLED, forward_w=100.0)
        c, dev = _connected([on, _invalid_word(), _invalid_word()])
        c._tick()  # good, RF ON
        c._tick()  # first invalid: discarded
        assert c.state is ControllerState.CONNECTED
        c._tick()  # second consecutive: persisting garbage while RF on -> loud FAULT
        assert c.state is ControllerState.FAULT
        assert any("link lost while RF was ON" in r for r in c.fault_reasons)
        assert dev.rf_off_calls >= 1
        assert c.device is not None

    def test_two_consecutive_invalid_words_with_rf_off_count_toward_link_loss(self):
        g = _benign_telemetry()
        c, _ = _connected([g, _invalid_word(), _invalid_word(), _invalid_word()])
        c._tick()  # good, RF off
        c._tick()  # first invalid: discarded
        assert c._read_failures == 0
        c._tick()  # second consecutive -> treated as read failure #1
        assert c.state is ControllerState.CONNECTED
        assert c.fault_reasons == ()
        assert c._read_failures == 1
        c._tick()  # third consecutive -> read failure #2
        assert c._read_failures == 2
        assert c.state is ControllerState.CONNECTED

    def test_persisting_invalid_words_then_a_timeout_drop_the_link(self):
        g = _benign_telemetry()
        c, _ = _connected(
            [g, _invalid_word(), _invalid_word(), _invalid_word(), TimeoutError("gone")]
        )
        for _ in range(4):
            c._tick()
        assert c._read_failures == 2 and c.state is ControllerState.CONNECTED
        c._tick()  # third failure of any kind -> existing link-loss behavior
        assert c.state is ControllerState.DISCONNECTED
        assert c.device is None

    def test_invalid_then_timeout_then_invalid_is_not_a_fresh_first_glitch(self):
        """Only a GOOD read resets the invalid streak: a timeout between two invalid words does not
        make the second one a discardable 'first' glitch (mixed garbage = a bad link, fail safe)."""
        g = _benign_telemetry()
        c, _ = _connected([g, _invalid_word(), TimeoutError("t"), _invalid_word()])
        for _ in range(4):
            c._tick()
        assert c._read_failures == 2  # the timeout + the second invalid word

    def test_invalid_streak_does_not_leak_across_detach(self):
        """A streak from an old link must not make the first glitch on a re-attached link count as
        the second (manual detach and the auto link-drop both start the next link clean)."""
        g = _benign_telemetry()
        c, _ = _connected([g, _invalid_word()])
        c._tick()
        c._tick()  # streak = 1 on the old device
        c.detach_device()
        assert c._invalid_status_reads == 0

    def test_invalid_streak_does_not_leak_across_auto_link_drop(self):
        g = _benign_telemetry()
        c, _ = _connected(
            [g, TimeoutError("a"), TimeoutError("b"), _invalid_word(), _invalid_word()]
        )
        for _ in range(4):  # 2 timeouts + 1 discarded glitch (streak = 1)
            c._tick()
        assert c._invalid_status_reads == 1
        c._tick()  # 2nd invalid -> read failure #3 -> link dropped
        assert c.state is ControllerState.DISCONNECTED
        assert c._invalid_status_reads == 0

    def test_a_real_over_temperature_word_still_trips(self):
        """Regression: a VALID word (only bit 10, OVER_TEMPERATURE) must fault exactly as before."""
        g = _benign_telemetry()
        hot = replace(_benign_telemetry(), status=Status.OVER_TEMPERATURE)
        c, dev = _connected([g, hot])
        c._tick()
        c._tick()
        assert c.state is ControllerState.FAULT
        assert "generator reports OVER_TEMPERATURE" in c.fault_reasons
        assert dev.rf_off_calls >= 1


class TestInvalidStatusWordStillEnforcesLimits:
    """S1: an unreadable status word must not blind protection. The same GP/GS frames still carry
    forward/reverse power and temperature, so the absolute limits are enforced on every invalid
    word, and forward power marks RF as live for the link-loss classification."""

    def test_rf_just_enabled_persistent_invalid_words_fault_not_quiet_disconnect(self):
        """Reviewer's probe: last good sample RF OFF, operator enables RF, every GS now garbled
        while 50 W flows -> a loud FAULT, never a quiet DISCONNECTED."""
        g = _benign_telemetry()
        c, dev = _connected([g] + [_invalid_word(forward_w=50.0, reverse_w=1.0)] * 6)
        states = []
        for _ in range(6):
            if c.device is None:
                break
            c._tick()
            states.append(c.state)
        assert ControllerState.DISCONNECTED not in states
        assert c.state is ControllerState.FAULT
        assert any("RF" in r for r in c.fault_reasons)
        assert c.device is not None
        assert dev.rf_off_calls >= 1

    def test_single_invalid_word_with_reflected_over_limit_faults(self):
        g = _benign_telemetry()
        c, dev = _connected([g, _invalid_word(forward_w=150.0, reverse_w=40.0)],
                            limits=SafetyLimits(max_reflected_w=25.0))
        c._tick()
        c._tick()
        assert c.state is ControllerState.FAULT
        assert any("reflected" in r and "0xFFFF" in r for r in c.fault_reasons)
        assert dev.rf_off_calls >= 1

    def test_single_invalid_word_with_temperature_over_limit_faults(self):
        g = _benign_telemetry()
        c, _ = _connected([g, _invalid_word(temperature_c=80.0)],
                          limits=SafetyLimits(temperature_c_trip=70.0))
        c._tick()
        c._tick()
        assert c.state is ControllerState.FAULT
        assert any("temperature" in r and "0xFFFF" in r for r in c.fault_reasons)

    def test_single_invalid_word_with_sane_partial_reading_is_still_discarded(self):
        g = _benign_telemetry()
        c, dev = _connected([g, _invalid_word(forward_w=150.0, reverse_w=2.0, temperature_c=30.0)])
        c._tick()
        c._tick()
        assert c.state is ControllerState.CONNECTED
        assert c.fault_reasons == ()
        assert c._read_failures == 0
        assert dev.rf_off_calls == 0


class TestInvalidStatusWordWindow:
    """S2: >= 3 invalid words in the last 20 reads is a read failure even when not consecutive."""

    def test_alternating_good_invalid_rf_off_escalates_on_the_third(self):
        g = _benign_telemetry()
        c, _ = _connected([g, _invalid_word(), g, _invalid_word(), g, _invalid_word()])
        for _ in range(4):
            c._tick()
        assert c._read_failures == 0  # 2 isolated glitches: both discarded
        assert c.snapshot()["invalid_status_reads_recent"] == 2
        c._tick()  # good
        c._tick()  # 3rd invalid in the window -> treated as a read failure
        assert c._read_failures == 1
        assert c.snapshot()["invalid_status_reads_recent"] == 3
        assert c.state is ControllerState.CONNECTED

    def test_alternating_good_invalid_rf_on_faults_on_the_third(self):
        on = replace(_benign_telemetry(), rf_on=True, status=Status.RF_ENABLED, forward_w=100.0)
        bad = _invalid_word(forward_w=100.0, reverse_w=1.0)
        c, _ = _connected([on, bad, on, bad, on, bad])
        for _ in range(4):
            c._tick()
        assert c.state is ControllerState.CONNECTED
        c._tick()
        c._tick()
        assert c.state is ControllerState.FAULT

    def test_window_forgets_glitches_older_than_20_reads(self):
        g = _benign_telemetry()
        script = [g, _invalid_word()] + [g] * 19 + [_invalid_word(), g, _invalid_word()]
        c, _ = _connected(script)
        for _ in range(len(script)):
            c._tick()
        assert c.snapshot()["invalid_status_reads_recent"] == 2
        assert c._read_failures == 0
        assert c.state is ControllerState.CONNECTED

    def test_snapshot_exposes_zero_when_clean(self):
        c, _ = _connected([_benign_telemetry()])
        c._tick()
        assert c.snapshot()["invalid_status_reads_recent"] == 0


class TestDiscardedReadRefreshesStaleness:
    """I1: the device DID answer on a discarded read, so it refreshes the staleness clock — a
    glitch plus one slow cycle must not reach the 2-read stale debounce."""

    def test_glitch_then_one_slow_cycle_does_not_trip_stale(self):
        clock = {"t": 0.0}
        g = _benign_telemetry()
        dev = _ScriptedDevice([g, _invalid_word(), g, g])
        c = Controller(dev, poll_interval_s=0.01, clock=lambda: clock["t"],
                       limits=SafetyLimits(telemetry_timeout_s=1.5))
        c.state = ControllerState.CONNECTED
        c._tick()  # good at t=0
        clock["t"] = 1.0
        c._tick()  # discarded glitch at t=1.0 (device answered)
        clock["t"] = 2.0
        c._tick()  # good: gap since the glitch 1.0 s (< 1.5)
        clock["t"] = 3.7
        c._tick()  # one slow cycle: gap 1.7 s (late, but only once)
        assert c.state is ControllerState.CONNECTED
        assert c.fault_reasons == ()


class TestInvalidStatusWordEndToEnd:
    def test_real_codec_path_discards_a_single_0xffff_frame(self):
        """Through the REAL CxnDevice + codec: one GS frame with status 0xFFFF must not fault."""
        transport = SimulatedCxnTransport(reflected_fraction=0.01)
        c = Controller(CxnDevice(transport), poll_interval_s=0.01)
        c.connect()
        seen: list[dict] = []
        c.add_listener(seen.append)
        c._tick()
        real_word = transport._status_word
        transport._status_word = lambda: 0xFFFF  # type: ignore[method-assign]
        c._tick()
        transport._status_word = real_word  # type: ignore[method-assign]
        assert c.state is ControllerState.CONNECTED
        assert c.fault_reasons == ()
        assert c.latest_telemetry is not None and c.latest_telemetry.rf_on is False
        assert len(seen) == 1  # the 0xFFFF read notified nobody
        assert c._read_failures == 0
        c._tick()
        assert c.state is ControllerState.CONNECTED
        assert len(seen) == 2

    def test_real_codec_path_discards_a_single_0xffff_frame_with_rf_on(self):
        transport = SimulatedCxnTransport(reflected_fraction=0.01)
        c = Controller(CxnDevice(transport), poll_interval_s=0.01)
        c.connect()
        c.set_setpoint(150)
        c.enable_rf()
        seen: list[dict] = []
        c.add_listener(seen.append)
        c._tick()
        assert c.latest_telemetry is not None and c.latest_telemetry.rf_on is True
        real_word = transport._status_word
        transport._status_word = lambda: 0xFFFF  # type: ignore[method-assign]
        c._tick()  # 150 W fwd, 1.5 W refl, sane temperature -> a discardable glitch
        transport._status_word = real_word  # type: ignore[method-assign]
        assert c.state is ControllerState.CONNECTED
        assert c.fault_reasons == ()
        assert len(seen) == 1
        assert c._read_failures == 0
        assert transport.rf_on is True  # protection did not need to drop RF
        c._tick()
        assert c.state is ControllerState.CONNECTED


class TestPolling:
    """``polling``: is the generator poll loop live? The app's idle observer stays silent exactly
    while it is (a slow ~1 s real read leaves long gaps between ticks; the loop is still live)."""

    def test_polling_tracks_start_detach_and_link_drop(self):
        c = make_controller()
        assert c.polling is False  # never started (e.g. a boot whose connect failed)
        c.start()
        assert c.polling is True
        c.detach_device()
        assert c.polling is False
        dev = _FlakyDevice(rf_on=False)
        c2 = Controller(dev, poll_interval_s=0.01, link_loss_reads=1)
        c2.connect()
        c2._start_polling()
        assert c2.polling is True
        dev.fail = True
        deadline = time.monotonic() + 1.0
        while c2.polling and time.monotonic() < deadline:
            time.sleep(0.01)
        assert c2.polling is False  # an idle link drop ends polling (no device any more)
        c2.stop()
