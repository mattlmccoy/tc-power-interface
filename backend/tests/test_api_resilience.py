"""The operator must serve — and let settings be saved — even when the device won't connect, so you
can configure limits/plan before the generator is plugged in."""

from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app


def _client(tmp_path):
    return TestClient(
        create_app(
            backend="simulated",
            poll_interval_s=0.05,
            experiments_root=tmp_path,
            transport_kwargs={"deny_control": True},  # device refuses the control lease
        )
    )


def test_operator_serves_when_device_denies_control(tmp_path):
    with _client(tmp_path) as c:
        s = c.get("/api/status").json()
        assert s["controller"]["state"] in ("disconnected", "fault")


def test_can_save_safety_limits_while_disconnected(tmp_path):
    with _client(tmp_path) as c:
        r = c.put(
            "/api/safety-limits",
            json={
                "max_forward_w": 300,
                "max_reflected_w": 20,
                "temperature_c_trip": 65,
                "forward_caution_w": 380,
                "forward_danger_w": 480,
            },
        )
        assert r.status_code == 200
        assert c.get("/api/safety-limits").json()["max_forward_w"] == 300


def test_can_save_thermal_plan_while_disconnected(tmp_path):
    with _client(tmp_path) as c:
        r = c.put(
            "/api/thermal/plan",
            json={
                "target_c": 180,
                "soak_s": 60,
                "approach_band_c": 10,
                "loop_ceiling_w": 200,
                "max_step_w": 10,
                "done_below_c": 60,
            },
        )
        assert r.status_code == 200
        assert c.get("/api/thermal/plan").json()["target_c"] == 180
