import pytest

from tc_power_interface.control.match_tuner import (
    MATCH_TUNER_BOUNDS,
    MatchTuner,
    MatchTunerPlan,
    backlash_takeup,
)
from tc_power_interface.device.reflection import FLOOR, reflected_fraction
from tc_power_interface.device.simulated import backlash_position


def test_backlash_takeup_adds_slack_only_on_a_direction_reversal():
    # same direction: plain step (no slack to take up)
    assert backlash_takeup(step=1.0, direction=1, last_dir=1, backlash=0.6) == 1.0
    assert backlash_takeup(step=0.3, direction=-1, last_dir=-1, backlash=0.6) == -0.3
    # first move (no prior direction): plain step
    assert backlash_takeup(step=1.0, direction=1, last_dir=0, backlash=0.6) == 1.0
    # reversal: add the backlash takeup in the new direction
    assert backlash_takeup(step=1.0, direction=-1, last_dir=1, backlash=0.6) == -1.6
    assert backlash_takeup(step=1.0, direction=1, last_dir=-1, backlash=0.6) == 1.6
    # shrunk step still gets the full takeup on a reversal
    assert backlash_takeup(step=0.1, direction=-1, last_dir=1, backlash=0.6) == -0.7
    # backlash 0 disables the comp
    assert backlash_takeup(step=1.0, direction=-1, last_dir=1, backlash=0.0) == -1.0


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


class BacklashController:
    """Like FakeController but models the AIT's backlash: the readback (.tune/.load) tracks the
    command, while the RF reflection responds to a PHYSICAL capacitance that lags with lost motion.
    This is what the tuner's backlash comp exists to cancel."""

    def __init__(self, tune=50.0, load=50.0, t_opt=62.0, l_opt=40.0, lash=0.6):
        self.tune = tune  # commanded / readback
        self.load = load
        self._tphys = tune  # physical capacitance (the reflection sees this)
        self._lphys = load
        self._tdir = 0
        self._ldir = 0
        self.lash = lash
        self.t_opt = t_opt
        self.l_opt = l_opt
        self.rf_enabled_calls = 0

    def set_tune_capacity(self, p):
        p = max(0.0, min(100.0, p))
        self._tphys, self._tdir = backlash_position(
            phys=self._tphys, engaged_dir=self._tdir, prev_cmd=self.tune, cmd=p, lash=self.lash
        )
        self.tune = p

    def set_load_capacity(self, p):
        p = max(0.0, min(100.0, p))
        self._lphys, self._ldir = backlash_position(
            phys=self._lphys, engaged_dir=self._ldir, prev_cmd=self.load, cmd=p, lash=self.lash
        )
        self.load = p

    def enable_rf(self):  # must never be called by the tuner
        self.rf_enabled_calls += 1

    def reverse_fraction(self):
        return reflected_fraction(self._tphys, self._lphys, self.t_opt, self.l_opt)


def test_backlash_comp_reaches_a_well_uncompensated_search_cannot():
    # A cap with real backlash: WITH the comp the search reaches the well minimum; WITHOUT it
    # (backlash=0) the first step after every reversal is eaten by slack, so it stalls far short.
    # (We track the BEST reverse reached — settling tightly at the minimum is a separate concern.)
    comp = BacklashController()
    nocomp = BacklashController()
    mt_comp = MatchTuner(comp, plan=MatchTunerPlan(mode="auto"))  # backlash 0.6 (default)
    mt_nocomp = MatchTuner(nocomp, plan=MatchTunerPlan(mode="auto", backlash=0.0))
    for mt in (mt_comp, mt_nocomp):
        mt.start()
        mt.arm()
    best_comp = best_nocomp = 1.0
    for _ in range(400):
        mt_comp.tick(0.5, _telemetry(comp))
        mt_nocomp.tick(0.5, _telemetry(nocomp))
        best_comp = min(best_comp, comp.reverse_fraction())
        best_nocomp = min(best_nocomp, nocomp.reverse_fraction())
    assert best_comp < FLOOR + 0.02  # comp reaches the well minimum
    assert best_comp < best_nocomp - 0.05  # and meaningfully better than the uncompensated run


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


def test_guard_undoes_a_move_that_spikes_reverse_and_holds():
    # A move that drives reverse UP past the guard is undone and the tuner backs off to holding.
    # With a backlash cap the undo is compensated: the PHYSICAL cap returns to the start (the
    # command overshoots by the takeup to drive back through the slack).
    fake = BacklashController(tune=50.0, load=50.0)
    mt = MatchTuner(fake, plan=MatchTunerPlan(mode="auto", guard=0.6))
    mt.start()
    mt.arm()
    # tick 1: low reverse -> the tuner makes its first (tune) move away from 50.
    mt.tick(0.5, {"rf_on": True, "manual_mode": True, "reverse_fraction": 0.10,
                  "tune_cap_percent": 50.0, "load_cap_percent": 50.0})
    moved_tune = fake.tune
    assert moved_tune != 50.0
    # tick 2: that move spiked reverse above the guard -> undo it and hold.
    mt.tick(0.5, {"rf_on": True, "manual_mode": True, "reverse_fraction": 0.70,
                  "tune_cap_percent": moved_tune, "load_cap_percent": 50.0})
    assert mt.snapshot()["phase"] == "holding"
    assert fake._tphys == pytest.approx(50.0)  # the physical cap was driven back to the start


def test_caps_stay_in_bounds():
    fake = FakeController(t_opt=95.0, l_opt=95.0)  # optimum outside [0,100] pull
    mt = MatchTuner(fake, plan=MatchTunerPlan(mode="auto", min_cap=0.0, max_cap=100.0))
    mt.start()
    mt.arm()
    for _ in range(300):
        mt.tick(0.5, _telemetry(fake))
    assert 0.0 <= fake.tune <= 100.0 and 0.0 <= fake.load <= 100.0
