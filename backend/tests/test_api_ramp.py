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
        c.post("/api/ramp/start")
        reached = False
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            rr = c.get("/api/status").json()["ramp"]
            if rr["output_w"] >= 190:
                reached = True
                break
            time.sleep(0.05)
        assert reached
        c.post("/api/ramp/stop")
        assert c.get("/api/status").json()["ramp"]["running"] is False
