"""Tests for replaying a recorded temperature trace through the real ThermalController.

The replay is a counterfactual advisory overlay: it feeds recorded temperatures into the actual
control code and reports the phase + commanded power it WOULD have produced. It does not re-simulate
(the recorded temperatures are fixed history).
"""

from tc_power_interface.control.replay import ReplayStep, replay_recorded
from tc_power_interface.control.thermal_loop import ThermalPlan


def _linear(t0, t1, c0, c1, n):
    times = [t0 + (t1 - t0) * i / (n - 1) for i in range(n)]
    temps = [c0 + (c1 - c0) * i / (n - 1) for i in range(n)]
    return times, temps


def test_returns_one_step_per_sample():
    times, temps = _linear(0, 30, 25, 160, 61)
    plan = ThermalPlan(target_c=100, soak_s=5)
    steps = replay_recorded(times, temps, plan=plan, max_forward_w=350)
    assert len(steps) == len(times)
    assert isinstance(steps[0], ReplayStep)
    assert steps[0].t == 0.0


def test_command_never_exceeds_loop_ceiling():
    times, temps = _linear(0, 30, 25, 160, 61)
    plan = ThermalPlan(target_c=100, soak_s=5, loop_ceiling_w=200)
    steps = replay_recorded(times, temps, plan=plan, max_forward_w=350)
    assert max(s.commanded_w for s in steps) <= plan.loop_ceiling_w
    assert min(s.commanded_w for s in steps) >= 0


def test_phase_progresses_ramp_to_soak_when_trace_crosses_target():
    # temp ramps from 25 to 160, crossing the 100 C target -> should reach SOAK.
    times, temps = _linear(0, 30, 25, 160, 61)
    plan = ThermalPlan(target_c=100, soak_s=5)
    steps = replay_recorded(times, temps, plan=plan, max_forward_w=350)
    phases = [s.phase for s in steps]
    assert phases[0] == "ramp"
    assert "approach" in phases
    assert "soak" in phases


def test_reports_the_recorded_temperature_it_saw():
    times, temps = _linear(0, 10, 30, 130, 11)
    steps = replay_recorded(times, temps, plan=ThermalPlan(target_c=200), max_forward_w=350)
    # the replayed control temp should track the recorded trace (last sample = 130)
    assert abs(steps[-1].temp_c - 130.0) < 0.5
