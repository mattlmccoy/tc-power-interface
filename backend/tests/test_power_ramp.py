"""Tests for software power ramping: ramp the RF setpoint from init to target at W/s (like the
generator's native RAMP mode: INIT power, RATE 1-99 W/s). It only drives the setpoint; never RF."""

from tc_power_interface.control.power_ramp import RampController, RampPlan, ramp_step
from tc_power_interface.control.safety import SafetyLimits


def test_ramp_step_up_clamps_at_target_no_overshoot():
    assert ramp_step(0, 200, 50, 1) == 50
    assert ramp_step(190, 200, 50, 1) == 200
    assert ramp_step(200, 200, 50, 1) == 200


def test_ramp_step_down():
    assert ramp_step(200, 100, 50, 1) == 150
    assert ramp_step(120, 100, 50, 1) == 100


def test_plan_bounded_clamps_targets_and_rate():
    p = RampPlan.bounded(init_w=-5, target_w=9999, rate_w_per_s=500, max_forward_w=350)
    assert p.init_w == 0
    assert p.target_w == 350  # clamped to max forward
    assert p.rate_w_per_s == 99  # RATE max (per the AG manual)


class FakeController:
    def __init__(self, max_forward=350):
        self.limits = SafetyLimits(max_forward_w=max_forward)
        self.last = None

    def set_setpoint(self, w):
        self.last = w
        return w


def test_controller_ramps_to_target_and_drives_setpoint():
    fake = FakeController()
    rc = RampController(fake, plan=RampPlan(init_w=0, target_w=200, rate_w_per_s=50))
    rc.start()
    assert fake.last == 0  # init power applied on start
    for _ in range(10):
        rc.tick(1.0, rf_on=True)
    assert rc.output_w == 200
    assert fake.last == 200
    assert rc.done is True


def test_controller_never_exceeds_max_forward():
    fake = FakeController(max_forward=150)
    rc = RampController(fake, plan=RampPlan(init_w=0, target_w=600, rate_w_per_s=50))
    rc.start()
    for _ in range(20):
        rc.tick(1.0, rf_on=True)
    assert fake.last is not None and fake.last <= 150


def test_stopped_ramp_does_not_drive():
    fake = FakeController()
    rc = RampController(fake, plan=RampPlan(init_w=0, target_w=200, rate_w_per_s=50))
    # never started
    rc.tick(1.0)
    assert fake.last is None


def test_ramp_holds_until_rf_on():
    """The switch may be armed before RF-on, but the ramp must NOT advance the setpoint until RF is
    actually energised (matching the AG generator's native RAMP, which only ramps while RF is on)."""
    fake = FakeController()
    rc = RampController(fake, plan=RampPlan(init_w=0, target_w=200, rate_w_per_s=50))
    rc.start()
    assert fake.last == 0  # init power applied on start
    # RF still OFF: ticking must hold at init, never climb the setpoint.
    for _ in range(10):
        rc.tick(1.0, rf_on=False)
    assert rc.output_w == 0
    assert fake.last == 0
    assert rc.done is False
    # RF ON: now the ramp advances to target.
    for _ in range(10):
        rc.tick(1.0, rf_on=True)
    assert rc.output_w == 200
    assert rc.done is True
