"""Tests for the per-tick control-telemetry POST (body builder + fire-and-forget poster).

Keys match the locked FLIR<->TC-POWER contract (2026-09-08). The poster's HTTP POST is injectable so
it is unit-tested without a live FLIR backend, mirroring FlirLink.
"""

from tc_power_interface.integration.control_telemetry import (
    ControlTelemetryPoster,
    HeartbeatGate,
    build_control_telemetry,
    build_power_heartbeat,
)

# --- power-only heartbeat (Matt, 2026-09-08): while the generator is connected but the thermal
# loop is NOT running (manual RF run), post just the RF power so FLIR stays "engaged" and gets an
# RF-power trace for EVERY run. FLIR needs nothing new: same endpoint, mode "manual", no thermal
# keys. ---


def test_build_power_heartbeat_has_only_the_power_keys_and_mode_manual():
    body = build_power_heartbeat(
        telemetry={"forward_w": 118.5, "reverse_w": 2.1, "reflected_fraction": 0.018,
                   "load_w": 116.4, "rf_on": True},
        ts="2026-09-08T21:50:00+00:00",
    )
    assert body == {
        "ts": "2026-09-08T21:50:00+00:00",
        "mode": "manual",
        "forward_w": 118.5,
        "reverse_w": 2.1,
        "reflected_fraction": 0.018,
    }
    # No thermal-loop keys leak into a manual heartbeat (FLIR labels these "RF: <W>", not "loop:").
    thermal_keys = {"setpoint_c", "measured_c", "applied_w", "recommended_w", "phase", "roi"}
    assert not thermal_keys & body.keys()


def test_heartbeat_gate_admits_at_most_one_per_period():
    gate = HeartbeatGate(period_s=1.0)
    assert gate.due(now=100.0) is True  # first one always goes
    assert gate.due(now=100.4) is False  # too soon (the controller polls at 2 Hz)
    assert gate.due(now=100.99) is False
    assert gate.due(now=101.0) is True  # a full period elapsed
    assert gate.due(now=101.5) is False

THERMAL = {
    "phase": "ramp", "mode": "auto", "armed": True,
    "control_temp_c": 150.0, "target_c": 185.0,
    "recommended_w": 120.0, "applied_w": 118.0,
}
TELEMETRY = {"forward_w": 118.5, "reverse_w": 2.1, "reflected_fraction": 0.018, "load_w": 116.4}


def test_build_control_telemetry_maps_the_exact_contract_keys():
    body = build_control_telemetry(
        thermal=THERMAL, telemetry=TELEMETRY,
        roi="circle_medium_small", ts="2026-09-08T12:00:00.200Z",
    )
    assert body == {
        "ts": "2026-09-08T12:00:00.200Z",
        "setpoint_c": 185.0,
        "measured_c": 150.0,
        "applied_w": 118.0,
        "recommended_w": 120.0,
        "phase": "ramp",
        "mode": "auto",
        "armed": True,
        "forward_w": 118.5,
        "reverse_w": 2.1,
        "reflected_fraction": 0.018,
        "error_c": 35.0,  # target_c - control_temp_c
        "roi": "circle_medium_small",
    }


def test_applied_w_null_passes_through_when_advisory():
    thermal = {**THERMAL, "applied_w": None}
    body = build_control_telemetry(
        thermal=thermal, telemetry=TELEMETRY, roi="r", ts="t",
    )
    assert body["applied_w"] is None


class _FakePost:
    def __init__(self):
        self.calls = []

    def __call__(self, url, body, timeout):
        self.calls.append({"url": url, "body": body, "timeout": timeout})


def test_poster_posts_to_control_telemetry_when_enabled():
    fp = _FakePost()
    poster = ControlTelemetryPoster("http://127.0.0.1:8000", enabled=True, _post=fp)
    poster.post({"measured_c": 150.0})
    poster.join()
    assert len(fp.calls) == 1
    assert fp.calls[0]["url"] == "http://127.0.0.1:8000/api/control/telemetry"
    assert fp.calls[0]["body"] == {"measured_c": 150.0}


def test_poster_is_a_noop_when_disabled_or_no_url():
    fp = _FakePost()
    ControlTelemetryPoster("http://x", enabled=False, _post=fp).post({"a": 1})
    ControlTelemetryPoster("", enabled=True, _post=fp).post({"a": 1})
    assert fp.calls == []


def test_poster_swallows_post_errors():
    def boom(url, body, timeout):
        raise RuntimeError("connection refused")

    poster = ControlTelemetryPoster("http://x", enabled=True, _post=boom)
    poster.post({"a": 1})
    poster.join()
    assert poster.last_result["ok"] is False  # never raised to the caller
