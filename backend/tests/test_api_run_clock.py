"""Run clock API on the simulated operator: set / +time / cancel / dismiss, counting RF-on time from
the real poll loop, recorded into the run, and never touching the generator."""

import csv
import json
import time

from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app


def _client(tmp_path):
    return TestClient(
        create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path)
    )


def _clock(c):
    return c.get("/api/status").json()["run_clock"]


def _wait_for(fn, timeout_s=2.0):
    deadline = time.monotonic() + timeout_s
    value = fn()
    while not value and time.monotonic() < deadline:
        time.sleep(0.05)
        value = fn()
    return value


def test_set_extend_cancel(tmp_path):
    with _client(tmp_path) as c:
        assert c.get("/api/run-clock").json()["phase"] == "off"
        r = c.post("/api/run-clock", json={"target_s": 720})
        assert r.status_code == 200 and r.json()["target_s"] == 720.0 and r.json()["set"] is True
        assert _clock(c)["phase"] == "paused"  # RF is off: nothing counts yet
        assert c.post("/api/run-clock/add", json={"seconds": 60}).json()["target_s"] == 780.0
        assert c.post("/api/run-clock/cancel").json()["phase"] == "off"
        assert c.post("/api/run-clock/dismiss").json()["phase"] == "off"  # nothing to dismiss


def test_bad_targets_are_422(tmp_path):
    with _client(tmp_path) as c:
        for bad in (0, -1, 24 * 3600 + 1):
            assert c.post("/api/run-clock", json={"target_s": bad}).status_code == 422
        assert c.post("/api/run-clock/add", json={"seconds": 0}).status_code == 422


def test_counts_rf_on_time_from_the_poll_loop_and_records_it(tmp_path):
    with _client(tmp_path) as c:
        c.post("/api/setpoint", json={"watts": 5})
        c.post("/api/rf/enable")  # auto-log starts a recording on the RF-on edge
        run = _wait_for(lambda: c.get("/api/recording/status").json()["run"])
        assert run
        c.post("/api/run-clock", json={"target_s": 600})
        assert _wait_for(lambda: (_clock(c)["on_s"] or 0) > 0.2), _clock(c)
        assert _clock(c)["phase"] == "running" and _clock(c)["counting"] is True
        c.post("/api/rf/disable")
        assert _wait_for(lambda: _clock(c)["counting"] is False)
        c.post("/api/run-clock/cancel")
        c.post("/api/recording/stop")
    events = [e["label"] for e in json.loads((tmp_path / run / "events.json").read_text())]
    assert "run_clock_set" in events and "run_clock_cancelled" in events
    with (tmp_path / run / "telemetry.csv").open() as f:
        rows = list(csv.DictReader(f))
    targets = {r["clock_target_s"] for r in rows}
    assert "600.0" in targets  # rows while the clock was set carry the target
    on = [float(r["clock_on_s"]) for r in rows if r["clock_on_s"]]
    assert on and max(on) > 0.2


def test_the_clock_never_touches_the_generator(tmp_path):
    with _client(tmp_path) as c:
        ctrl = c.app.state.controller
        calls = []
        for name in ("set_setpoint", "enable_rf", "disable_rf"):
            real = getattr(ctrl, name)
            setattr(ctrl, name, lambda *a, _n=name, _r=real, **k: calls.append(_n) or _r(*a, **k))
        c.post("/api/run-clock", json={"target_s": 1})
        time.sleep(0.3)  # several polls; the clock would be "over" if RF were on
        c.post("/api/run-clock/add", json={"seconds": 1})
        c.post("/api/run-clock/dismiss")
        c.post("/api/run-clock/cancel")
        assert calls == []
