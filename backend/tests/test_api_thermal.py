"""Tests for the thermal-loop API (plan, start/stop/arm, sim source, snapshot)."""

import time

from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app


def _client(tmp_path):
    return TestClient(
        create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path)
    )


def test_get_thermal_plan_defaults_and_bounds(tmp_path):
    with _client(tmp_path) as c:
        b = c.get("/api/thermal/plan").json()
        assert b["target_c"] == 185.0  # default = ~nylon 12 (PA12) melt temp
        assert b["bounds"]["target_c"] == [30, 300]


def test_put_thermal_plan_clamps_ceiling_to_max_forward(tmp_path):
    with _client(tmp_path) as c:
        r = c.put(
            "/api/thermal/plan",
            json={"target_c": 150, "soak_s": 30, "approach_band_c": 15,
                  "loop_ceiling_w": 9999, "max_step_w": 25, "done_below_c": 50},
        )
        assert r.status_code == 200
        assert r.json()["loop_ceiling_w"] == 350  # clamped to the default max_forward_w


def test_status_has_thermal_block(tmp_path):
    with _client(tmp_path) as c:
        th = c.get("/api/status").json()["thermal"]
        assert th["running"] is False
        assert th["phase"] == "ramp"


def test_start_auto_drives_setpoint_in_sim(tmp_path):
    with _client(tmp_path) as c:
        c.post("/api/rf/enable")  # operator enables RF (sim)
        c.post("/api/thermal/start", json={"mode": "auto"})
        applied = None
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            th = c.get("/api/status").json()["thermal"]
            if th["running"] and th["applied_w"] is not None:
                applied = th["applied_w"]
                break
            time.sleep(0.05)
        assert applied is not None  # the loop drove the setpoint
        c.post("/api/thermal/stop")


def test_arm_and_disarm(tmp_path):
    with _client(tmp_path) as c:
        assert c.post("/api/thermal/arm").status_code == 200
        assert c.post("/api/thermal/disarm").status_code == 200
