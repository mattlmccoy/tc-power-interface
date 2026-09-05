"""Tests for the FastAPI app (simulated backend, via Starlette TestClient)."""

import json
import time

import pytest
from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(backend="simulated", poll_interval_s=0.02, experiments_root=tmp_path)
    with TestClient(app) as c:
        yield c


def _wait_for(client: TestClient, predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        last = client.get("/api/status").json()
        if predicate(last):
            return last
        time.sleep(0.02)
    return last


def _rf_on(body):
    return (body["controller"]["telemetry"] or {}).get("rf_on")


class TestHealth:
    def test_health_ok(self, client):
        r = client.get("/api/health")
        assert r.status_code == 200
        body = r.json()
        assert body["backend"] == "simulated"
        assert "version" in body


class TestStatus:
    def test_status_has_device_identity_and_controller(self, client):
        body = client.get("/api/status").json()
        assert body["device"]["id"]
        assert body["device"]["power_limit_w"] == 600.0
        assert body["controller"]["state"] in ("connected", "fault")

    def test_telemetry_streams_into_status(self, client):
        body = _wait_for(client, lambda b: b["controller"]["telemetry"] is not None)
        assert body["controller"]["telemetry"] is not None


class TestSetpointAndRf:
    def test_setpoint_clamped_to_policy(self, client):
        r = client.post("/api/setpoint", json={"watts": 1000})
        assert r.status_code == 200
        assert r.json()["applied_w"] == 350

    def test_rf_enable_then_disable(self, client):
        assert client.post("/api/rf/enable").status_code == 200
        body = _wait_for(client, lambda b: _rf_on(b) is True)
        assert body["controller"]["telemetry"]["rf_on"] is True
        assert client.post("/api/rf/disable").status_code == 200
        body = _wait_for(client, lambda b: _rf_on(b) is False)
        assert body["controller"]["telemetry"]["rf_on"] is False


class TestRecording:
    def test_start_record_stop_writes_run(self, client, tmp_path):
        r = client.post("/api/recording/start", json={"name": "api run", "notes": "n"})
        assert r.status_code == 200
        run_name = r.json()["run"]
        time.sleep(0.15)  # let a few samples land
        assert client.post("/api/recording/stop").status_code == 200

        run_dir = tmp_path / run_name
        assert (run_dir / "metadata.json").exists()
        assert (run_dir / "manifest.json").exists()
        manifest = json.loads((run_dir / "manifest.json").read_text())
        assert manifest["complete"] is True
        assert manifest["sample_count"] >= 1


class TestTelemetryWebSocket:
    def test_ws_emits_full_status(self, client):
        with client.websocket_connect("/ws/telemetry") as ws:
            msg = ws.receive_json()
        assert "device" in msg
        assert "controller" in msg
        assert "state" in msg["controller"]
        assert "telemetry" in msg["controller"]
