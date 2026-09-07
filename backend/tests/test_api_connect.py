"""Tests for runtime device discovery + connect/disconnect (the connect popover).

The operator can boot IDLE (backend="none") and attach a device at runtime, mirroring FLIR's
Setup flow. The simulator stands in for the real serial generator here (no hardware in CI)."""

import time

from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app


def _idle_client(tmp_path):
    return TestClient(create_app(backend="none", poll_interval_s=0.05, experiments_root=tmp_path))


def test_idle_boot_serves_disconnected(tmp_path):
    with _idle_client(tmp_path) as c:
        s = c.get("/api/status").json()
        assert s["controller"]["state"] == "disconnected"
        assert s["controller"]["telemetry"] is None  # no device attached -> no telemetry


def test_discovery_lists_ports(tmp_path, monkeypatch):
    # Fake two serial ports so the test does not depend on the host's hardware.
    class _P:
        def __init__(self, device, description, hwid):
            self.device, self.description, self.hwid = device, description, hwid

    monkeypatch.setattr(
        "serial.tools.list_ports.comports",
        lambda: [
            _P("/dev/tty.usbserial-A1", "USB Serial", "USB VID:PID=0403:6001"),
            _P("/dev/cu.Bluetooth-Incoming-Port", "n/a", "n/a"),  # macOS noise -> filtered
        ],
    )
    with _idle_client(tmp_path) as c:
        d = c.get("/api/discovery").json()
        assert d["connected"] is None  # nothing attached at idle boot
        ports = {p["device"] for p in d["ports"]}
        assert "/dev/tty.usbserial-A1" in ports
        assert "/dev/cu.Bluetooth-Incoming-Port" not in ports  # noise filtered out


def test_connect_then_disconnect_simulator(tmp_path):
    with _idle_client(tmp_path) as c:
        # Connect the simulator stand-in (same code path a real serial port takes).
        r = c.post("/api/connect", json={"backend": "simulated"})
        assert r.status_code == 200
        # It connects and starts polling; RF stays OFF on connect.
        connected = False
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            s = c.get("/api/status").json()
            if s["controller"]["state"] == "connected" and s["controller"]["telemetry"] is not None:
                connected = True
                assert s["controller"]["telemetry"]["rf_on"] is False  # never auto-enabled
                break
            time.sleep(0.05)
        assert connected
        # Disconnect -> back to disconnected, no device.
        assert c.post("/api/disconnect").status_code == 200
        s = c.get("/api/status").json()
        assert s["controller"]["state"] == "disconnected"
        assert s["controller"]["telemetry"] is None
