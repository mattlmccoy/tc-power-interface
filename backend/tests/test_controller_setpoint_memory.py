from tc_power_interface.control.controller import Controller
from tc_power_interface.control.safety import SafetyLimits
from tc_power_interface.device.cxn import CxnDevice
from tc_power_interface.device.simulated import SimulatedCxnTransport


def make_controller() -> Controller:
    c = Controller(CxnDevice(SimulatedCxnTransport()), limits=SafetyLimits(), poll_interval_s=0.01)
    c.connect()
    return c


def test_snapshot_reports_none_before_any_setpoint() -> None:
    c = make_controller()
    assert c.snapshot()["last_setpoint_w"] is None


def test_set_setpoint_is_remembered_clamped() -> None:
    c = make_controller()
    applied = c.set_setpoint(50)
    assert c.snapshot()["last_setpoint_w"] == applied


def test_estop_records_zero_and_detach_clears() -> None:
    c = make_controller()
    c.set_setpoint(50)
    c.estop()
    assert c.snapshot()["last_setpoint_w"] == 0
    c.detach_device()
    assert c.snapshot()["last_setpoint_w"] is None


def test_link_drop_forgets_commanded_setpoint() -> None:
    dev = CxnDevice(SimulatedCxnTransport())
    c = Controller(dev, limits=SafetyLimits(), poll_interval_s=0.01, link_loss_reads=1)
    c.connect()
    c.set_setpoint(50)
    c._tick()  # one good read: RF is off, so a later failure is a benign idle link drop

    def _lost() -> None:
        raise TimeoutError("serial read timed out: got 0 of 1 bytes")

    dev.read_telemetry = _lost  # type: ignore[method-assign, assignment]
    c._tick()  # failure 1 == link_loss_reads -> _drop_link
    assert c.device is None
    assert c.snapshot()["last_setpoint_w"] is None
