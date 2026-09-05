"""Tests for the device layer: byte-level simulated transport + CxnDevice wrapper.

The simulated transport exercises the REAL codec (encode/decode/parse) end to end, so these
tests confirm the command builders, framing, and parsers compose correctly. Behaviour of the
simulator is a documented model of the CXN, not a capture from the physical unit.
"""

import pytest

from tc_power_interface.device import create_transport
from tc_power_interface.device.cxn import CxnDevice
from tc_power_interface.protocol import codec


@pytest.fixture
def device() -> CxnDevice:
    return CxnDevice(create_transport("simulated"))


class TestRegistry:
    def test_simulated_transport_is_registered(self):
        t = create_transport("simulated")
        assert hasattr(t, "write") and hasattr(t, "read")

    def test_unknown_transport_raises(self):
        with pytest.raises(KeyError):
            create_transport("does-not-exist")


class TestControlLease:
    def test_request_control_succeeds(self, device: CxnDevice):
        assert device.request_control() is True

    def test_release_control_disables_rf(self, device: CxnDevice):
        device.request_control()
        device.set_setpoint(150)
        device.set_rf(True)
        assert device.read_telemetry().rf_on is True
        device.release_control()
        assert device.read_telemetry().rf_on is False


class TestTelemetry:
    def test_idle_telemetry_reports_zero_power_and_rf_off(self, device: CxnDevice):
        device.request_control()
        t = device.read_telemetry()
        assert t.forward_w == 0.0
        assert t.reverse_w == 0.0
        assert t.rf_on is False
        assert codec.Status.RF_ENABLED not in t.status
        assert t.host_timestamp_ns > 0

    def test_setpoint_and_rf_on_produce_forward_power(self, device: CxnDevice):
        device.request_control()
        device.set_setpoint(150)
        device.set_rf(True)
        t = device.read_telemetry()
        assert t.rf_on is True
        assert t.forward_w == 150.0
        # simulated reflected fraction is 1%
        assert t.reverse_w == pytest.approx(1.5)
        assert t.reflected_fraction == pytest.approx(0.01, abs=1e-3)
        assert t.load_w == pytest.approx(148.5)

    def test_rf_ignored_without_control(self, device: CxnDevice):
        # No request_control(): the device must not enable RF.
        device.set_setpoint(150)
        device.set_rf(True)
        assert device.read_telemetry().rf_on is False


class TestIdentify:
    def test_identify_returns_id_serial_firmware_frequency_limit(self, device: CxnDevice):
        info = device.identify()
        assert info["id"]
        assert info["serial"]
        assert info["firmware"]["ui"]
        assert info["frequency_hz"] == 13_560_000
        assert info["power_limit_w"] == 600.0


class TestMatchReadout:
    def test_manual_mode_and_capacities_roundtrip(self, device: CxnDevice):
        device.request_control()
        device.set_manual_mode(True)
        device.set_tune_capacity(42)
        device.set_load_capacity(55)
        gt = device.read_match()
        assert gt.manual_mode is True
        assert gt.tune_capacity == 42.0
        assert gt.load_capacity == 55.0


class TestProtocolErrors:
    def test_unknown_command_is_nacked(self):
        t = create_transport("simulated")
        t.write(codec.encode_command(b"ZZ\x00\x00\x00\x00"))
        assert t.read(1) == codec.ACK_BAD

    def test_device_raises_on_nack(self, device: CxnDevice):
        with pytest.raises(ValueError):
            device._query(b"ZZ\x00\x00\x00\x00")  # unsupported command
