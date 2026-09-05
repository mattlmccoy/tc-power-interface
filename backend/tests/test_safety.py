"""Tests for the pure safety/protection evaluator (Watts-based reflected trip, hard-bounded)."""

from tc_power_interface.control.safety import (
    HARD_BOUNDS,
    SafetyLimits,
    evaluate,
)
from tc_power_interface.device.base import Telemetry
from tc_power_interface.protocol.codec import Status


def mk(**kw) -> Telemetry:
    base = dict(
        host_timestamp_ns=1,
        forward_w=0.0,
        reverse_w=0.0,
        load_w=0.0,
        reflected_fraction=0.0,
        status=Status(0),
        rf_on=False,
        temperature_c=30.0,
        operation_mode="normal",
        tuner="analog tuner",
    )
    base.update(kw)
    return Telemetry(**base)


LIMITS = SafetyLimits()


class TestDefaults:
    def test_defaults(self):
        assert LIMITS.max_forward_w == 350
        assert LIMITS.max_reflected_w == 25.0
        assert LIMITS.temperature_c_trip == 70.0


class TestBounded:
    def test_clamps_each_field_into_hard_range(self):
        s = SafetyLimits.bounded(max_forward_w=9999, max_reflected_w=9999, temperature_c_trip=999)
        assert s.max_forward_w == HARD_BOUNDS["max_forward_w"][1]  # 400
        assert s.max_reflected_w == HARD_BOUNDS["max_reflected_w"][1]  # 200
        assert s.temperature_c_trip == HARD_BOUNDS["temperature_c_trip"][1]  # 90

    def test_clamps_up_to_minimums(self):
        s = SafetyLimits.bounded(max_forward_w=-5, max_reflected_w=0, temperature_c_trip=0)
        assert s.max_forward_w == 0
        assert s.max_reflected_w == HARD_BOUNDS["max_reflected_w"][0]  # 1
        assert s.temperature_c_trip == HARD_BOUNDS["temperature_c_trip"][0]  # 30

    def test_in_range_values_preserved(self):
        s = SafetyLimits.bounded(max_forward_w=300, max_reflected_w=40, temperature_c_trip=65)
        assert (s.max_forward_w, s.max_reflected_w, s.temperature_c_trip) == (300, 40.0, 65.0)


class TestClampSetpoint:
    def test_clamps_to_max_forward_w(self):
        assert SafetyLimits(max_forward_w=350).clamp_setpoint(1000) == 350
        assert SafetyLimits(max_forward_w=350).clamp_setpoint(100) == 100
        assert SafetyLimits(max_forward_w=350).clamp_setpoint(-5) == 0


class TestReflectedTrip:
    def test_trips_when_reverse_watts_exceed_limit(self):
        d = evaluate(mk(rf_on=True, forward_w=300, reverse_w=30.0),
                     SafetyLimits(max_reflected_w=25.0), telemetry_age_s=0.1)
        assert d.trip is True
        assert any("reflect" in r.lower() for r in d.reasons)

    def test_no_trip_below_limit_even_at_high_fraction(self):
        # 4 W reflected of 5 W forward = 80% fraction but only 4 W -> below a 25 W limit -> no trip
        d = evaluate(mk(rf_on=True, forward_w=5, reverse_w=4.0, reflected_fraction=0.8),
                     SafetyLimits(max_reflected_w=25.0), telemetry_age_s=0.1)
        assert d.trip is False

    def test_no_reflected_trip_when_rf_off(self):
        d = evaluate(mk(rf_on=False, reverse_w=999), LIMITS, telemetry_age_s=0.1)
        assert d.trip is False

    def test_fraction_warn_is_advisory_not_a_trip(self):
        d = evaluate(mk(rf_on=True, forward_w=300, reverse_w=10.0, reflected_fraction=0.05),
                     SafetyLimits(max_reflected_w=25.0, reflected_fraction_warn=0.02),
                     telemetry_age_s=0.1)
        assert d.trip is False
        assert d.warnings != ()


class TestHardwareFaults:
    def test_over_temperature_status_trips(self):
        assert evaluate(mk(status=Status.OVER_TEMPERATURE), LIMITS, 0.1).trip is True

    def test_interlock_open_trips(self):
        assert evaluate(mk(status=Status.INTERLOCK_OPEN), LIMITS, 0.1).trip is True

    def test_heatsink_over_limit_trips(self):
        assert evaluate(mk(temperature_c=95.0), LIMITS, 0.1).trip is True


class TestCommsTimeout:
    def test_stale_telemetry_trips(self):
        d = evaluate(mk(), LIMITS, telemetry_age_s=5.0)
        assert d.trip is True
