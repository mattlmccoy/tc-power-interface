"""Tests for the power-ramp API (config/bounds, start drives the setpoint, status block)."""

import time

from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app


def _client(tmp_path):
    return TestClient(
        create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path)
    )


def test_ramp_config_exposes_bounds(tmp_path):
    with _client(tmp_path) as c:
        b = c.get("/api/ramp").json()
        assert b["bounds"]["rate_w_per_s"] == [1, 99]


def test_ramp_put_clamps_rate_to_99(tmp_path):
    with _client(tmp_path) as c:
        r = c.put("/api/ramp", json={"init_w": 0, "target_w": 200, "rate_w_per_s": 500})
        assert r.status_code == 200
        assert r.json()["rate_w_per_s"] == 99


def test_status_has_ramp_block(tmp_path):
    with _client(tmp_path) as c:
        rr = c.get("/api/status").json()["ramp"]
        assert rr["running"] is False
        assert rr["target_w"] == 100


def test_ramp_start_drives_the_setpoint(tmp_path):
    with _client(tmp_path) as c:
        c.put("/api/ramp", json={"init_w": 0, "target_w": 200, "rate_w_per_s": 300})
        c.post("/api/rf/enable")  # ramp only advances while RF is energised
        c.post("/api/ramp/start")
        # It drives the setpoint up off init while RF is on. We assert a modest level reached in the
        # first ticks (robust: the sim's protection can later trip RF on the imperfect default match,
        # after which the ramp holds — that hold is covered by test_ramp_holds_while_rf_off; the full
        # climb to target is covered by the RampController unit test).
        reached = False
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            rr = c.get("/api/status").json()["ramp"]
            if rr["output_w"] >= 10:
                reached = True
                break
            time.sleep(0.02)
        assert reached
        c.post("/api/ramp/stop")
        assert c.get("/api/status").json()["ramp"]["running"] is False


def test_ramp_holds_while_rf_off(tmp_path):
    """Arming the ramp with RF off must NOT climb the setpoint; it advances only after RF-on."""
    with _client(tmp_path) as c:
        c.put("/api/ramp", json={"init_w": 0, "target_w": 200, "rate_w_per_s": 300})
        c.post("/api/ramp/start")  # armed, but RF is OFF
        time.sleep(0.4)  # several poll ticks
        rr = c.get("/api/status").json()["ramp"]
        assert rr["running"] is True
        assert rr["output_w"] == 0  # held at init — never climbed while RF off
        assert c.get("/api/status").json()["controller"]["telemetry"]["rf_on"] is False
        # Now energise RF: the ramp starts advancing.
        c.post("/api/rf/enable")
        climbed = False
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            if c.get("/api/status").json()["ramp"]["output_w"] > 0:
                climbed = True
                break
            time.sleep(0.05)
        assert climbed
