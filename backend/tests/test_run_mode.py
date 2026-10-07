"""Run mode = display and bookkeeping only (spec §3.5): it never changes power by itself."""

import json

import pytest

from tc_power_interface.control.run_mode import (
    FILE_NAME,
    RunMode,
    load_run_mode,
    parse_run_mode,
    save_run_mode,
)


def test_defaults_bake_in_no_run_numbers():
    assert RunMode() == RunMode(mode="ladder", ladder_w=(), fixed_w=0, fixed_min=0.0)


def test_parse_clamps_sorts_and_rejects():
    m = parse_run_mode({"mode": "ladder", "ladder_w": [40, 5, 5, 999, -3, "x"]}, max_forward_w=400)
    assert m.ladder_w == (5, 40, 400)
    fixed = parse_run_mode({"mode": "fixed", "fixed_w": 900, "fixed_min": 10}, max_forward_w=400)
    assert fixed.fixed_w == 400
    with pytest.raises(ValueError, match="not available"):
        parse_run_mode({"mode": "angle"}, max_forward_w=400)
    with pytest.raises(ValueError, match="unknown"):
        parse_run_mode({"mode": "warp"}, max_forward_w=400)


def test_persists(tmp_path):
    assert load_run_mode(tmp_path) == RunMode()
    save_run_mode(tmp_path, RunMode(mode="target"))
    assert load_run_mode(tmp_path).mode == "target"


@pytest.mark.parametrize("text", ["[1, 2]", '{"mode": 5}', "not json at all", '"ladder"', "null"])
def test_corrupt_file_loads_as_default(tmp_path, text):
    (tmp_path / FILE_NAME).write_text(text)
    assert load_run_mode(tmp_path) == RunMode()


def test_non_finite_numbers_are_dropped_or_zeroed():
    nan, inf = float("nan"), float("inf")
    m = parse_run_mode(
        {"mode": "fixed", "ladder_w": [nan, inf, -inf, 10], "fixed_w": nan, "fixed_min": inf},
        max_forward_w=400,
    )
    assert m.ladder_w == (10,)
    assert m.fixed_w == 0
    assert m.fixed_min == 0.0


def test_booleans_are_not_power_steps():
    m = parse_run_mode({"mode": "ladder", "ladder_w": [True, False, 20]}, max_forward_w=400)
    assert m.ladder_w == (20,)
    assert parse_run_mode({"mode": "fixed", "fixed_w": True}, max_forward_w=400).fixed_w == 0


def test_round_trip_preserves_ladder(tmp_path):
    m = RunMode(mode="ladder", ladder_w=(5, 15, 40), fixed_w=25, fixed_min=12.5)
    save_run_mode(tmp_path, m)
    assert load_run_mode(tmp_path) == m
    assert json.loads((tmp_path / FILE_NAME).read_text())["ladder_w"] == [5, 15, 40]
