"""Tests for the Controller: lease keepalive, protection application, guarded RF path.

Logic is tested by driving `_tick()` directly (no threads); one lifecycle test exercises the
real background thread against the simulator.
"""

import time

import pytest

from tc_power_interface.control.controller import Controller, ControllerState
from tc_power_interface.control.safety import SafetyLimits
from tc_power_interface.device.cxn import CxnDevice
from tc_power_interface.device.simulated import SimulatedCxnTransport


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

    def test_read_exception_faults_and_commands_rf_off(self):
        class ExplodingDevice:
            def __init__(self):
                self.rf_off_calls = 0

            def request_control(self):
                return True

            def read_telemetry(self):
                raise RuntimeError("cable yanked")

            def set_rf(self, on):
                if on is False:
                    self.rf_off_calls += 1

            def set_setpoint(self, w):
                pass

            def release_control(self):
                return True

        dev = ExplodingDevice()
        c = Controller(dev, poll_interval_s=0.01)
        c.connect()
        c._tick()
        assert c.state is ControllerState.FAULT
        assert dev.rf_off_calls >= 1


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


class TestSetpointGuard:
    def test_setpoint_clamped_to_policy_ceiling(self):
        c = make_controller(max_setpoint_w=350)
        c.connect()
        c.set_setpoint(1000)
        c.enable_rf()
        c._tick()
        assert c.latest_telemetry.forward_w == 350.0


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
