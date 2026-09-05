"""Tests for the pure safety/protection evaluator.

The protection layer is deliberately a pure function of a telemetry sample + limits + sample
age, so it can be exercised exhaustively without threads or hardware. The controller thread
just applies its verdict (RF off on any trip).
"""

from tc_power_interface.control.safety import SafetyLimits, evaluate
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


class TestNoTrip:
    def test_healthy_idle_does_not_trip(self):
        assert evaluate(mk(), LIMITS, telemetry_age_s=0.1).trip is False

    def test_healthy_rf_on_low_reflection_does_not_trip(self):
        d = evaluate(mk(rf_on=True, forward_w=150, reverse_w=1.5, reflected_fraction=0.01),
                     LIMITS, telemetry_age_s=0.1)
        assert d.trip is False
        assert d.warnings == ()


class TestReflectedPower:
    def test_trips_when_reflected_fraction_exceeds_limit(self):
        d = evaluate(mk(rf_on=True, forward_w=150, reverse_w=30, reflected_fraction=0.20),
                     LIMITS, telemetry_age_s=0.1)
        assert d.trip is True
        assert any("reflect" in r.lower() for r in d.reasons)

    def test_warns_between_warn_and_trip_thresholds(self):
        d = evaluate(mk(rf_on=True, forward_w=150, reverse_w=7.5, reflected_fraction=0.05),
                     LIMITS, telemetry_age_s=0.1)
        assert d.trip is False
        assert d.warnings != ()

    def test_no_reflected_trip_when_rf_off(self):
        d = evaluate(mk(rf_on=False, reflected_fraction=0.9), LIMITS, telemetry_age_s=0.1)
        assert d.trip is False

    def test_absolute_reflected_watt_trip_when_configured(self):
        limits = SafetyLimits(reflected_w_trip=10.0)
        d = evaluate(mk(rf_on=True, forward_w=400, reverse_w=12, reflected_fraction=0.03),
                     limits, telemetry_age_s=0.1)
        assert d.trip is True


class TestHardwareFaults:
    def test_over_temperature_status_trips(self):
        d = evaluate(mk(status=Status.OVER_TEMPERATURE), LIMITS, telemetry_age_s=0.1)
        assert d.trip is True

    def test_interlock_open_trips(self):
        d = evaluate(mk(status=Status.INTERLOCK_OPEN), LIMITS, telemetry_age_s=0.1)
        assert d.trip is True

    def test_heatsink_temperature_over_limit_trips(self):
        d = evaluate(mk(temperature_c=95.0), LIMITS, telemetry_age_s=0.1)
        assert d.trip is True


class TestCommsTimeout:
    def test_stale_telemetry_trips(self):
        d = evaluate(mk(), LIMITS, telemetry_age_s=5.0)
        assert d.trip is True
        assert any("timeout" in r.lower() or "stale" in r.lower() for r in d.reasons)


class TestSetpointGuard:
    def test_clamp_setpoint_to_policy_ceiling(self):
        limits = SafetyLimits(max_setpoint_w=350)
        assert limits.clamp_setpoint(500) == 350
        assert limits.clamp_setpoint(100) == 100
        assert limits.clamp_setpoint(-5) == 0
