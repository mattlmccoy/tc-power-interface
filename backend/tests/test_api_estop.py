"""E-STOP: one call kills RF, zeroes the setpoint, and halts every driver
(ramp/pulse/timer/thermal)."""

import time

from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app


def _client(tmp_path):
    return TestClient(
        create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path)
    )


def test_estop_stops_all_drivers_and_rf(tmp_path):
    with _client(tmp_path) as c:
        c.post("/api/ramp/start")
        c.post("/api/timer/start")
        c.post("/api/pulse/start")
        c.post("/api/thermal/start", json={"mode": "advisory"})
        c.post("/api/rf/enable")
        time.sleep(0.15)  # let RF turn on

        r = c.post("/api/estop")
        assert r.status_code == 200

        s = c.get("/api/status").json()
        assert s["ramp"]["running"] is False
        assert s["timer"]["running"] is False
        assert s["pulse"]["running"] is False
        assert s["thermal"]["running"] is False

        # RF is commanded off; give the poll a moment to reflect it
        deadline = time.monotonic() + 1.0
        rf_on = True
        while time.monotonic() < deadline:
            tel = c.get("/api/status").json()["controller"]["telemetry"]
            rf_on = bool(tel and tel["rf_on"])
            if not rf_on:
                break
            time.sleep(0.05)
        assert rf_on is False
