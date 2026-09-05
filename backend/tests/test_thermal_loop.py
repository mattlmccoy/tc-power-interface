"""Tests for the pure thermal control law (ramp/approach/soak/cool) + plan bounds."""

from tc_power_interface.control.thermal_loop import (
    THERMAL_BOUNDS,
    ThermalPhase,
    ThermalPlan,
    plan_step,
)

PLAN = ThermalPlan(
    target_c=150, soak_s=30, approach_band_c=15, loop_ceiling_w=200, max_step_w=25, done_below_c=50
)


def test_bounds_clamp_plan():
    p = ThermalPlan.bounded(
        target_c=9999, soak_s=30, approach_band_c=15, loop_ceiling_w=9999,
        max_step_w=9999, done_below_c=50, max_forward_w=350,
    )
    assert p.target_c == THERMAL_BOUNDS["target_c"][1]  # 300
    assert p.loop_ceiling_w == 350  # clamped to max_forward_w (below the 400 hard cap)
    assert p.max_step_w == THERMAL_BOUNDS["max_step_w"][1]  # 50


def test_ramp_when_far_below_steps_up_capped():
    cmd = plan_step(
        temp_c=25, phase=ThermalPhase.RAMP, elapsed_soak_s=0, current_setpoint_w=0, plan=PLAN
    )
    assert cmd.phase == ThermalPhase.RAMP
    assert 0 < cmd.target_power_w <= PLAN.max_step_w


def test_never_exceeds_ceiling():
    cmd = plan_step(
        temp_c=25, phase=ThermalPhase.RAMP, elapsed_soak_s=0, current_setpoint_w=195, plan=PLAN
    )
    assert cmd.target_power_w <= PLAN.loop_ceiling_w


def test_approach_phase_eases_off_below_target():
    cmd = plan_step(
        temp_c=140, phase=ThermalPhase.RAMP, elapsed_soak_s=0, current_setpoint_w=200, plan=PLAN
    )
    assert cmd.phase == ThermalPhase.APPROACH
    assert cmd.target_power_w < 200


def test_soak_then_cool_after_soak_time():
    at = plan_step(
        temp_c=151, phase=ThermalPhase.APPROACH, elapsed_soak_s=0, current_setpoint_w=80, plan=PLAN
    )
    assert at.phase == ThermalPhase.SOAK
    done = plan_step(
        temp_c=151, phase=ThermalPhase.SOAK, elapsed_soak_s=31, current_setpoint_w=80, plan=PLAN
    )
    assert done.phase == ThermalPhase.COOL
    assert done.target_power_w == 0


def test_cool_to_done_below_threshold():
    cmd = plan_step(
        temp_c=40, phase=ThermalPhase.COOL, elapsed_soak_s=0, current_setpoint_w=0, plan=PLAN
    )
    assert cmd.phase == ThermalPhase.DONE
    assert cmd.target_power_w == 0
