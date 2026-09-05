"""Tests for the ADVISORY thermal-trajectory evaluator.

This is the seed of the future FLIR closed-loop thermal controller. It is a pure recommender:
given a control-ROI temperature and a target, it advises increase/hold/reduce. It NEVER enables
RF and it is NOT a safety layer (over-temperature / reflected-power trips live in safety.py).
The 'reduce before target' behaviour encodes the thermal-lag caution from the 2026-09-04 handoff.
"""

from tc_power_interface.control.thermal import ThermalTarget, recommend

TARGET = ThermalTarget(target_c=200.0, approach_band_c=20.0)


def test_well_below_target_recommends_increase():
    rec = recommend(current_c=120.0, target=TARGET)
    assert rec.action == "increase"


def test_within_approach_band_recommends_hold():
    # 190 is within 20 C of the 200 target -> ease off / hold to coast up via thermal lag
    rec = recommend(current_c=190.0, target=TARGET)
    assert rec.action == "hold"


def test_at_or_above_target_recommends_reduce():
    assert recommend(current_c=200.0, target=TARGET).action == "reduce"
    assert recommend(current_c=215.0, target=TARGET).action == "reduce"


def test_recommendation_carries_a_reason():
    assert recommend(current_c=100.0, target=TARGET).reason
