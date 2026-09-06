from tc_power_interface.control.match_tuner import (
    MATCH_TUNER_BOUNDS,
    MatchTuner,
    MatchTunerPlan,
)
from tc_power_interface.device.reflection import FLOOR, reflected_fraction


def test_bounded_clamps_out_of_range_steps_and_validates_mode():
    p = MatchTunerPlan.bounded(mode="auto", tune_step=99.0, load_step=0.0, guard=5.0)
    assert p.mode == "auto"
    assert p.tune_step == MATCH_TUNER_BOUNDS["tune_step"][1]  # clamped to max
    assert p.load_step == MATCH_TUNER_BOUNDS["load_step"][0]  # clamped to min
    assert p.guard == MATCH_TUNER_BOUNDS["guard"][1]  # clamped to max


def test_bounded_rejects_unknown_mode_falling_back_to_advisory():
    p = MatchTunerPlan.bounded(mode="ATUNE", tune_step=1.0, load_step=0.3, guard=0.6)
    assert p.mode == "advisory"


class FakeController:
    """Drives caps against the sim well; reverse power = well(tune,load) at a fixed optimum."""

    def __init__(self, tune=50.0, load=50.0, t_opt=62.0, l_opt=40.0):
        self.tune = tune
        self.load = load
        self.t_opt = t_opt
        self.l_opt = l_opt
        self.rf_enabled_calls = 0

    def set_tune_capacity(self, p):
        self.tune = max(0.0, min(100.0, p))

    def set_load_capacity(self, p):
        self.load = max(0.0, min(100.0, p))

    def enable_rf(self):  # must never be called by the tuner
        self.rf_enabled_calls += 1

    def reverse_fraction(self):
        return reflected_fraction(self.tune, self.load, self.t_opt, self.l_opt)


def _telemetry(fake, *, rf_on=True, manual=True):
    return {"rf_on": rf_on, "manual_mode": manual, "reverse_fraction": fake.reverse_fraction()}


def test_converges_to_the_well_minimum_in_auto():
    fake = FakeController()
    mt = MatchTuner(fake, plan=MatchTunerPlan(mode="auto"))
    mt.start()
    mt.arm()
    for _ in range(400):
        mt.tick(0.5, _telemetry(fake))
    assert fake.reverse_fraction() < FLOOR + 0.03  # reached near the floor


def test_advisory_mode_never_moves_caps():
    fake = FakeController()
    mt = MatchTuner(fake, plan=MatchTunerPlan(mode="advisory"))
    mt.start()
    mt.arm()
    for _ in range(50):
        mt.tick(0.5, _telemetry(fake))
    assert (fake.tune, fake.load) == (50.0, 50.0)
    assert mt.snapshot()["recommended"] is not None


def test_never_enables_rf():
    fake = FakeController()
    mt = MatchTuner(fake, plan=MatchTunerPlan(mode="auto"))
    mt.start()
    mt.arm()
    for _ in range(100):
        mt.tick(0.5, _telemetry(fake))
    assert fake.rf_enabled_calls == 0


def test_holds_when_rf_off_or_not_armed():
    fake = FakeController()
    mt = MatchTuner(fake, plan=MatchTunerPlan(mode="auto"))
    mt.start()  # not armed
    for _ in range(20):
        mt.tick(0.5, _telemetry(fake))
    assert (fake.tune, fake.load) == (50.0, 50.0)
    mt.arm()
    for _ in range(20):
        mt.tick(0.5, _telemetry(fake, rf_on=False))  # RF off -> no drive + auto-disarm
    assert (fake.tune, fake.load) == (50.0, 50.0)
    assert mt.snapshot()["armed"] is False


def test_caps_stay_in_bounds():
    fake = FakeController(t_opt=95.0, l_opt=95.0)  # optimum outside [0,100] pull
    mt = MatchTuner(fake, plan=MatchTunerPlan(mode="auto", min_cap=0.0, max_cap=100.0))
    mt.start()
    mt.arm()
    for _ in range(300):
        mt.tick(0.5, _telemetry(fake))
    assert 0.0 <= fake.tune <= 100.0 and 0.0 <= fake.load <= 100.0
