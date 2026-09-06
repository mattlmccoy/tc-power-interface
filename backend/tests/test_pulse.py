"""Tests for simulator-first PULSE: gate the RF setpoint ON for TIME ON then 0 for TIME OFF
(1-9995 ms each, per the AG Plasma manual). It only modulates the setpoint; it never enables RF.
The real generator's PULSE command is unverified — this models the waveform in the simulator."""

from tc_power_interface.control.pulse import PulseController, PulsePlan, duty_cycle, pulse_on
from tc_power_interface.control.safety import SafetyLimits


def test_pulse_on_is_periodic():
    # 1000 ms on / 1000 ms off -> 2 s period
    assert pulse_on(0.5, 1000, 1000) is True
    assert pulse_on(1.5, 1000, 1000) is False
    assert pulse_on(2.5, 1000, 1000) is True  # next period


def test_duty_cycle():
    assert duty_cycle(1000, 1000) == 0.5
    assert duty_cycle(3000, 1000) == 0.75


def test_plan_bounded_clamps():
    p = PulsePlan.bounded(on_ms=0, off_ms=99999, power_w=9999, max_forward_w=350)
    assert p.on_ms == 1  # min 1 ms
    assert p.off_ms == 9995  # max 9995 ms
    assert p.power_w == 350  # clamped to max forward


class FakeController:
    def __init__(self, max_forward=350):
        self.limits = SafetyLimits(max_forward_w=max_forward)
        self.last = None

    def set_setpoint(self, w):
        self.last = w
        return w


def test_controller_gates_setpoint_on_then_off():
    fake = FakeController()
    pc = PulseController(fake, plan=PulsePlan(on_ms=1000, off_ms=1000, power_w=100))
    pc.start()
    pc.tick(0.5)  # within ON window
    assert fake.last == 100
    assert pc.snapshot()["output_on"] is True
    pc.tick(1.0)  # elapsed 1.5 s -> OFF window
    assert fake.last == 0
    assert pc.snapshot()["output_on"] is False


def test_stopped_pulse_does_not_drive():
    fake = FakeController()
    pc = PulseController(fake, plan=PulsePlan(on_ms=1000, off_ms=1000, power_w=100))
    pc.tick(0.5)  # never started
    assert fake.last is None
