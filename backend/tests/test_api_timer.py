"""Tests for the auto-shutoff timer API (config/bounds, start, status block)."""

from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app


def _client(tmp_path):
    return TestClient(
        create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path)
    )


def test_timer_config_exposes_bounds(tmp_path):
    with _client(tmp_path) as c:
        b = c.get("/api/timer").json()
        assert b["bounds"]["minutes"] == [1, 99]


def test_timer_put_clamps_minutes(tmp_path):
    with _client(tmp_path) as c:
        r = c.put("/api/timer", json={"minutes": 999})
        assert r.status_code == 200
        assert r.json()["minutes"] == 99


def test_status_has_timer_block(tmp_path):
    with _client(tmp_path) as c:
        tt = c.get("/api/status").json()["timer"]
        assert tt["running"] is False
        assert tt["minutes"] == 10


def test_timer_start_stop(tmp_path):
    with _client(tmp_path) as c:
        c.put("/api/timer", json={"minutes": 5})
        assert c.post("/api/timer/start").json()["running"] is True
        assert c.post("/api/timer/stop").json()["running"] is False
