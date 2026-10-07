"""/api/status carries the controller link block and the RF on-time clock (simulated backend)."""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    app = create_app(backend="simulated", poll_interval_s=0.02, experiments_root=tmp_path)
    with TestClient(app) as c:
        yield c


def _wait_for(
    client: TestClient, pred: Callable[[dict[str, Any]], bool], timeout: float = 3.0
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    body: dict[str, Any] = {}
    while time.monotonic() < deadline:
        body = client.get("/api/status").json()
        if pred(body):
            return body
        time.sleep(0.02)
    return body


def test_status_has_controller_link_block(client: TestClient) -> None:
    body = _wait_for(client, lambda b: b["controller"]["link"]["poll_seq"] >= 2)
    link = body["controller"]["link"]
    assert link["poll_seq"] >= 2
    assert link["last_ok_age_s"] is not None and link["last_ok_age_s"] < 1.0
    assert link["read_failures"] == 0


def test_status_has_rf_clock_block_idle(client: TestClient) -> None:
    body = _wait_for(client, lambda b: b["rf_clock"]["rf_on"] is not None)
    clock = body["rf_clock"]
    assert set(clock) == {
        "rf_on", "burn_s", "last_burn_s", "run_rf_on_s", "run", "stale", "known", "last_run_rf_on_s"
    }
    assert clock["rf_on"] is False
    assert clock["known"] is True
    assert clock["burn_s"] is None
    assert clock["stale"] is False


def test_rf_clock_counts_burn_and_run_then_records_last_burn(client: TestClient) -> None:
    # 20 W: the untuned simulator reflects most of it, which stays under the 25 W reflected trip
    assert client.post("/api/setpoint", json={"watts": 20}).status_code == 200
    assert client.post("/api/rf/enable").status_code == 200
    on = _wait_for(client, lambda b: b["rf_clock"]["rf_on"] is True)
    assert on["rf_clock"]["burn_s"] is not None
    # the RF-on edge auto-starts a recording; the run total follows it
    body = _wait_for(
        client, lambda b: b["rf_clock"]["run"] is not None and b["rf_clock"]["run_rf_on_s"] > 0.1
    )
    assert body["rf_clock"]["run"] == body["recording"]["run"]
    assert body["rf_clock"]["run_rf_on_s"] > 0.1
    assert client.post("/api/rf/disable").status_code == 200
    off = _wait_for(client, lambda b: b["rf_clock"]["rf_on"] is False)
    assert off["rf_clock"]["burn_s"] is None
    assert off["rf_clock"]["last_burn_s"] is not None and off["rf_clock"]["last_burn_s"] > 0.1


def test_rf_clock_stale_when_no_device(tmp_path: Path) -> None:
    app = create_app(backend="none", experiments_root=tmp_path)
    with TestClient(app) as c:
        body = c.get("/api/status").json()
    assert body["controller"]["link"]["last_ok_age_s"] is None
    assert body["rf_clock"]["stale"] is True
    assert body["rf_clock"]["rf_on"] is None
    assert body["rf_clock"]["known"] is False  # never connected: neutral, not a lost link


def test_rf_clock_not_known_after_disconnect(client: TestClient) -> None:
    _wait_for(client, lambda b: b["rf_clock"]["known"] is True)
    body = client.post("/api/disconnect").json()
    assert body["rf_clock"]["known"] is False
    assert client.get("/api/status").json()["rf_clock"]["known"] is False


def test_rf_clock_known_again_after_reconnect(client: TestClient) -> None:
    client.post("/api/disconnect")
    assert client.post("/api/connect", json={"backend": "simulated"}).status_code == 200
    body = _wait_for(client, lambda b: b["rf_clock"]["known"] is True)
    assert body["rf_clock"]["known"] is True
    assert body["rf_clock"]["stale"] is False


def test_rf_clock_shows_last_run_after_recording_stops(client: TestClient) -> None:
    r = client.post("/api/recording/start", json={"name": "lr", "notes": ""})
    assert r.status_code == 200
    _wait_for(client, lambda b: b["rf_clock"]["run"] is not None)
    assert client.post("/api/recording/stop").status_code == 200
    body = _wait_for(client, lambda b: b["rf_clock"]["last_run_rf_on_s"] is not None)
    assert body["rf_clock"]["run"] is None
    assert body["rf_clock"]["last_run_rf_on_s"] == 0.0  # RF never on in that run
