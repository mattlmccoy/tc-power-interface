"""Tests for GET/PUT /api/safety-limits (editable, hard-bounded, persisted, live)."""

from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app


def _client(tmp_path):
    return TestClient(
        create_app(backend="simulated", poll_interval_s=0.02, experiments_root=tmp_path)
    )


def test_get_safety_limits_includes_values_and_bounds(tmp_path):
    with _client(tmp_path) as c:
        b = c.get("/api/safety-limits").json()
        assert b["max_forward_w"] == 350
        assert b["max_reflected_w"] == 25.0
        assert b["bounds"]["max_forward_w"] == [0, 400]


def test_put_clamps_persists_and_swaps_live(tmp_path):
    with _client(tmp_path) as c:
        r = c.put(
            "/api/safety-limits",
            json={"max_forward_w": 9999, "max_reflected_w": 2, "temperature_c_trip": 65},
        )
        assert r.status_code == 200
        assert r.json()["max_forward_w"] == 400  # clamped to hard cap
        # live + persisted: the status snapshot reflects the new limit
        assert c.get("/api/status").json()["controller"]["limits"]["max_forward_w"] == 400


def test_put_limits_persist_across_restart(tmp_path):
    with _client(tmp_path) as c:
        c.put(
            "/api/safety-limits",
            json={"max_forward_w": 200, "max_reflected_w": 10, "temperature_c_trip": 60},
        )
    # a fresh app on the same experiments_root loads the saved limits
    with _client(tmp_path) as c2:
        assert c2.get("/api/safety-limits").json()["max_forward_w"] == 200
