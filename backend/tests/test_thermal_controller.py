"""Tests for ThermalController: the arming gate + safety invariants (never enables RF)."""

from tc_power_interface.control.safety import SafetyLimits
from tc_power_interface.control.temperature import SimulatedThermalSource, TemperatureSample
from tc_power_interface.control.thermal_loop import ThermalController, ThermalPhase, ThermalPlan


class InvalidSource:
    """A source whose reading is never valid (models FLIR before a frame / after a stream drop)."""

    def read(self) -> TemperatureSample:
        return TemperatureSample(celsius=0.0, valid=False, ts=0.0)


class FakeController:
    def __init__(self, *, backend="simulated", rf_on=True, faulted=False, forward_w=0.0):
        self.backend = backend
        self._rf_on = rf_on
        self._faulted = faulted
        self.forward_w = forward_w
        self.enable_calls = 0
        self.last_setpoint = None
        self.limits = SafetyLimits(max_forward_w=350)

    def set_setpoint(self, w):
        self.last_setpoint = w
        self.forward_w = w
        return w

    def enable_rf(self):
        self.enable_calls += 1

    def snapshot(self):
        return {
            "state": "fault" if self._faulted else "connected",
            "telemetry": {
                "rf_on": self._rf_on,
                "forward_w": self.forward_w,
                "reverse_w": self.forward_w * 0.01,
                "load_w": self.forward_w * 0.99,
            },
        }


def _tc(fake, **kw):
    return ThermalController(fake, SimulatedThermalSource(), plan=ThermalPlan(), **kw)


def test_never_enables_rf():
    fake = FakeController()
    tc = _tc(fake, mode="auto")
    tc.start()
    for _ in range(50):
        tc.tick(0.1)
    assert fake.enable_calls == 0


def test_auto_drives_setpoint_in_sim():
    fake = FakeController(backend="simulated", rf_on=True)
    tc = _tc(fake, mode="auto")
    tc.start()
    tc.tick(0.1)
    assert fake.last_setpoint is not None


def test_advisory_mode_does_not_drive():
    fake = FakeController(backend="simulated", rf_on=True)
    tc = _tc(fake, mode="advisory")
    tc.start()
    tc.tick(0.1)
    assert fake.last_setpoint is None
    assert tc.recommended_w >= 0  # still computes a recommendation


def test_setpoint_never_exceeds_ceiling():
    fake = FakeController(backend="simulated", rf_on=True)
    tc = _tc(fake, mode="auto")
    tc.start()
    for _ in range(300):
        tc.tick(0.1)
    assert fake.last_setpoint is None or fake.last_setpoint <= ThermalPlan().loop_ceiling_w


def test_real_backend_advisory_until_armed():
    fake = FakeController(backend="serial", rf_on=True)
    tc = _tc(fake, mode="auto")
    tc.start()
    tc.tick(0.1)
    assert fake.last_setpoint is None  # not armed -> advisory
    tc.arm()
    tc.tick(0.1)
    assert fake.last_setpoint is not None  # armed + rf_on -> drives


def test_fault_disarms_and_stops_driving():
    fake = FakeController(backend="serial", rf_on=True)
    tc = _tc(fake, mode="auto")
    tc.start()
    tc.arm()
    fake._faulted = True
    tc.tick(0.1)
    assert tc.armed is False
    assert fake.last_setpoint is None


def test_rf_off_disarms():
    fake = FakeController(backend="serial", rf_on=True)
    tc = _tc(fake, mode="auto")
    tc.start()
    tc.arm()
    fake._rf_on = False
    tc.tick(0.1)
    assert tc.armed is False


def test_invalid_temperature_does_not_drive():
    # An absent/stale reading (celsius=0, valid=False) must NOT be treated as 0 C and ramped from;
    # the loop backs off to 0 W and never drives the setpoint.
    fake = FakeController(backend="simulated", rf_on=True)
    tc = ThermalController(fake, InvalidSource(), plan=ThermalPlan(), mode="auto")
    tc.start()
    tc.tick(0.1)
    assert fake.last_setpoint is None
    assert tc.recommended_w == 0.0
    assert "invalid" in tc.reason.lower()


def test_converges_toward_target_in_sim():
    fake = FakeController(backend="simulated", rf_on=True)
    tc = ThermalController(
        fake,
        SimulatedThermalSource(k_heat=0.125, k_cool=0.1),
        plan=ThermalPlan(target_c=150, soak_s=1),
        mode="auto",
    )
    tc.start()
    for _ in range(2000):
        tc.tick(0.1)
    assert 140 < tc.control_temp_c < 165 or tc.phase in (
        ThermalPhase.SOAK,
        ThermalPhase.COOL,
        ThermalPhase.DONE,
    )
