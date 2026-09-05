"""Tests for persisting the thermal plan to .thermal_plan.json."""

from tc_power_interface.control.thermal_loop import ThermalPlan
from tc_power_interface.control.thermal_store import load_plan, save_plan


def test_load_missing_returns_defaults(tmp_path):
    assert load_plan(tmp_path, max_forward_w=350) == ThermalPlan()


def test_roundtrip(tmp_path):
    save_plan(tmp_path, ThermalPlan(target_c=120, soak_s=10, loop_ceiling_w=150))
    p = load_plan(tmp_path, max_forward_w=350)
    assert p.target_c == 120
    assert p.soak_s == 10
    assert p.loop_ceiling_w == 150


def test_load_clamps_ceiling_to_max_forward(tmp_path):
    (tmp_path / ".thermal_plan.json").write_text(
        '{"target_c":150,"soak_s":30,"approach_band_c":15,'
        '"loop_ceiling_w":9999,"max_step_w":25,"done_below_c":50}'
    )
    assert load_plan(tmp_path, max_forward_w=300).loop_ceiling_w == 300
