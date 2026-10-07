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


def _spy_setpoint(c):
    """Record every setpoint write at the controller AND at the device (the wire)."""
    calls: list[tuple[str, int]] = []
    ctrl = c.app.state.controller
    real_ctrl, real_dev = ctrl.set_setpoint, ctrl.device.set_setpoint
    ctrl.set_setpoint = lambda w: calls.append(("controller", w)) or real_ctrl(w)
    ctrl.device.set_setpoint = lambda w: calls.append(("device", w)) or real_dev(w)
    return calls


def test_start_auto_is_refused_and_never_drives(tmp_path):
    # D12 (Matt, 2026-10-07): no loop drives power until the core interlock exists (v0.18). The
    # legacy auto loop used to drive the simulator's setpoint (25 -> 50 W); the API now refuses it.
    with _client(tmp_path) as c:
        calls = _spy_setpoint(c)
        r = c.post("/api/thermal/start", json={"mode": "auto"})
        assert r.status_code == 409
        assert "core interlock (v0.18)" in r.json()["detail"]
        th = c.get("/api/status").json()["thermal"]
        assert th["mode"] == "advisory" and th["running"] is False
        c.post("/api/rf/enable")  # operator enables RF (sim)
        time.sleep(0.5)  # ~10 ticks with RF on
        c.post("/api/rf/disable")
        assert c.app.state.thermal.mode == "advisory"
        assert calls == []


def test_start_advisory_still_works_and_never_drives_even_armed(tmp_path):
    with _client(tmp_path) as c:
        calls = _spy_setpoint(c)
        r = c.post("/api/thermal/start", json={"mode": "advisory"})
        assert r.status_code == 200 and r.json()["running"] is True
        assert r.json()["mode"] == "advisory"
        assert c.post("/api/thermal/arm").status_code == 200
        c.post("/api/rf/enable")
        # The advisory loop computes a recommendation every tick but never applies it.
        recommended = None
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and not recommended:
            th = c.get("/api/status").json()["thermal"]
            recommended = th["recommended_w"]
            time.sleep(0.05)
        c.post("/api/rf/disable")
        c.post("/api/thermal/stop")
        assert recommended  # it really ran (not a false green)
        assert c.get("/api/status").json()["thermal"]["applied_w"] is None
        assert calls == []


def test_start_unknown_mode_is_rejected_and_leaves_mode_advisory(tmp_path):
    with _client(tmp_path) as c:
        assert c.post("/api/thermal/start", json={"mode": "AUTO"}).status_code == 422
        assert c.app.state.thermal.mode == "advisory"
        assert c.app.state.thermal.running is False


def test_arm_and_disarm(tmp_path):
    with _client(tmp_path) as c:
        assert c.post("/api/thermal/arm").status_code == 200
        assert c.post("/api/thermal/disarm").status_code == 200
