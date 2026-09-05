"""Tests for GET/POST /api/flir-link (T&C -> FLIR link configuration endpoint)."""

from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app


def _client(tmp_path, **kw):
    app = create_app(backend="simulated", poll_interval_s=0.02, experiments_root=tmp_path, **kw)
    return TestClient(app)


def test_flir_link_defaults_disabled(tmp_path):
    with _client(tmp_path) as c:
        body = c.get("/api/flir-link").json()
        assert body["enabled"] is False


def test_set_flir_link_url_and_enable(tmp_path):
    with _client(tmp_path) as c:
        r = c.post("/api/flir-link", json={"url": "http://localhost:8000", "enabled": True})
        assert r.status_code == 200
        body = c.get("/api/flir-link").json()
        assert body["enabled"] is True
        assert body["url"] == "http://localhost:8000"
