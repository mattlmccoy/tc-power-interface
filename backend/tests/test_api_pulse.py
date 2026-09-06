"""Tests for the simulator-first PULSE API (config/bounds, start, status block)."""

from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app


def _client(tmp_path):
    return TestClient(
        create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path)
    )


def test_pulse_config_exposes_bounds(tmp_path):
    with _client(tmp_path) as c:
        b = c.get("/api/pulse").json()
        assert b["bounds"]["on_ms"] == [1, 9995]


def test_pulse_put_clamps(tmp_path):
    with _client(tmp_path) as c:
        r = c.put("/api/pulse", json={"on_ms": 0, "off_ms": 99999, "power_w": 50})
        assert r.status_code == 200
        assert r.json()["on_ms"] == 1
        assert r.json()["off_ms"] == 9995


def test_status_has_pulse_block(tmp_path):
    with _client(tmp_path) as c:
        pp = c.get("/api/status").json()["pulse"]
        assert pp["running"] is False
        assert pp["duty"] == 0.5


def test_pulse_start_stop(tmp_path):
    with _client(tmp_path) as c:
        assert c.post("/api/pulse/start").json()["running"] is True
        assert c.post("/api/pulse/stop").json()["running"] is False
