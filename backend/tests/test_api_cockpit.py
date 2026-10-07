"""Cockpit API: status blocks, watch + run-mode endpoints, engage locked, and nothing actuates."""

import csv
import json
import logging
import time

from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app


def _client(tmp_path):
    return TestClient(
        create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path)
    )


def _wait_for(fn, timeout_s=1.0):
    """Poll ``fn`` until it returns truthy (or the timeout); return its last value."""
    deadline = time.monotonic() + timeout_s
    value = fn()
    while not value and time.monotonic() < deadline:
        time.sleep(0.05)
        value = fn()
    return value


def test_status_has_cockpit_blocks(tmp_path):
    with _client(tmp_path) as c:
        th = c.get("/api/status").json()["thermal"]
        assert th["watch"] == [] and th["run_mode"]["mode"] == "ladder"
        assert th["shadow"]["valid"] is False and th["shadow"]["why"] == "learning"
        reason = "core interlock not built yet"
        assert th["engage"] == {"available": False, "reason": reason}


def test_watch_endpoint_validates_and_persists(tmp_path):
    with _client(tmp_path) as c:
        ok = c.post("/api/thermal/watch", json={"names": ["toroid_C", "toroid_D"]})
        assert ok.status_code == 200
        too_many = c.post("/api/thermal/watch", json={"names": ["a", "b", "c", "d", "e"]})
        assert too_many.status_code == 422
    with _client(tmp_path) as c:  # survives an operator restart
        # The simulated source has no FLIR roster, so each name reports "not_in_feed" — but the
        # NAME is present once the observer has ticked.
        watch = _wait_for(lambda: c.get("/api/status").json()["thermal"]["watch"])
        assert [w["name"] for w in watch] == ["toroid_C", "toroid_D"]


def test_run_mode_endpoint(tmp_path):
    with _client(tmp_path) as c:
        r = c.post("/api/run-mode", json={"mode": "ladder", "ladder_w": [10, 5]})
        assert r.status_code == 200 and r.json()["ladder_w"] == [5, 10]
        assert c.get("/api/run-mode").json()["ladder_w"] == [5, 10]
        assert c.post("/api/run-mode", json={"mode": "angle"}).status_code == 422


def test_engage_is_locked(tmp_path):
    with _client(tmp_path) as c:
        r = c.post("/api/thermal/engage")
        assert r.status_code == 409 and "interlock" in r.json()["detail"]


#: Device writes that move power or the matching caps. RF on/off (``set_rf``) is NOT here: the
#: test's own /api/rf/enable + /api/rf/disable cause exactly those, and nothing else.
_ACTUATING_DEVICE_METHODS = (
    "set_setpoint", "set_tune_capacity", "set_load_capacity", "force_manual_mode",
)


def _spy_device(device, calls):
    for name in _ACTUATING_DEVICE_METHODS:
        real = getattr(device, name)

        def spy(*args, _name=name, _real=real):
            calls.append((_name, args))
            return _real(*args)

        setattr(device, name, spy)


def test_cockpit_never_commands_power(tmp_path):
    with _client(tmp_path) as c:
        calls = []
        device_calls = []
        ctrl = c.app.state.controller
        real = ctrl.set_setpoint
        ctrl.set_setpoint = lambda w: calls.append(w) or real(w)
        _spy_device(ctrl.device, device_calls)  # the layer below the controller: the wire
        c.post("/api/run-mode", json={"mode": "target"})
        c.post("/api/thermal/watch", json={"names": ["toroid_C"]})
        c.post("/api/rf/enable")
        time.sleep(0.8)  # ~16 ticks with RF on: the observer runs every tick
        c.post("/api/rf/disable")
        assert calls == []
        assert device_calls == []
        # The spy is live (not a false green): an explicit operator setpoint IS seen at the device.
        assert c.post("/api/setpoint", json={"watts": 5}).status_code == 200
        assert ("set_setpoint", (5,)) in device_calls


def test_recording_carries_cockpit_columns_and_roi_sidecar(tmp_path):
    with _client(tmp_path) as c:
        c.post("/api/run-mode", json={"mode": "fixed", "fixed_w": 20})
        c.post("/api/rf/enable")  # auto-log starts a recording on the RF-on edge
        run = _wait_for(lambda: c.get("/api/recording/status").json()["run"])
        assert run
        time.sleep(0.5)
        c.post("/api/rf/disable")
        c.post("/api/recording/stop")
    run_dir = tmp_path / run
    with (run_dir / "telemetry.csv").open() as f:
        rows = list(csv.DictReader(f))
    assert rows and "setpoint_w" in rows[0]
    assert all(r["run_mode"] == "fixed" for r in rows)  # row 0 included
    # The simulated source has no FLIR roster, so the sidecar is header-only — it must still exist.
    assert (run_dir / "roi_temps.csv").is_file()


def test_save_source_from_roi_endpoint_keeps_watch(tmp_path):
    with _client(tmp_path) as c:
        c.post("/api/thermal/watch", json={"names": ["toroid_C"]})
        c.post("/api/thermal/roi", json={"name": "part"})
    with _client(tmp_path) as c:
        watch = _wait_for(lambda: c.get("/api/status").json()["thermal"]["watch"])
        assert [w["name"] for w in watch] == ["toroid_C"]
        assert c.get("/api/status").json()["thermal"]["control_roi"] == "part"


def test_run_mode_load_is_clamped_to_the_real_limit(tmp_path):
    (tmp_path / ".run_mode.json").write_text(json.dumps({"mode": "ladder", "ladder_w": [5, 9999]}))
    with _client(tmp_path) as c:
        status = c.get("/api/status").json()
        limit = c.app.state.controller.limits.max_forward_w
        assert max(status["thermal"]["run_mode"]["ladder_w"]) <= limit


def test_observer_failure_never_breaks_the_thermal_tick(tmp_path):
    class _Poster:  # stands in for the FLIR control-telemetry poster
        enabled = True

        def __init__(self):
            self.bodies = []

        def post(self, body):
            self.bodies.append(body)

    def _boom(**_kw):
        raise RuntimeError("observer bug")

    with _client(tmp_path) as c:
        poster = _Poster()
        c.app.state.control_telemetry = poster
        c.app.state.cockpit.observe = _boom
        # The rest of the tick (here: the 1 s power heartbeat to FLIR) still runs.
        assert _wait_for(lambda: poster.bodies, timeout_s=2.0)


def _rf_cycle(c, hold_s=0.3):
    """One RF on/off cycle (auto-log starts a recording); stop it and return the run name."""
    c.post("/api/rf/enable")
    run = _wait_for(lambda: c.get("/api/recording/status").json()["run"], timeout_s=2.0)
    time.sleep(hold_s)
    c.post("/api/rf/disable")
    time.sleep(0.15)  # let the RF-off edge be observed before the next rising edge
    c.post("/api/recording/stop")
    return run


def _rows(tmp_path, run):
    with (tmp_path / run / "telemetry.csv").open() as f:
        return list(csv.DictReader(f))


def test_row0_of_each_auto_logged_run_is_observed_under_that_run(tmp_path):
    """The observer must see a run's id on the SAME tick the auto-log starts it, so row 0 of a new
    run never carries the previous run's (un-reset) estimate. The simulated plant never reaches a
    valid first-order fit in a sub-second run, so a real shadow_k can't tell the runs apart;
    instead the record stamps which run id the observer last saw (white-box, deterministic)."""
    with _client(tmp_path) as c:
        cockpit = c.app.state.cockpit
        seen = {"run": None}
        real_observe = cockpit.observe

        def observe(**kw):
            seen["run"] = kw["run_id"]
            return real_observe(**kw)

        cockpit.observe = observe
        cockpit.record_fields = lambda: {"part_roi": f"observed:{seen['run']}"}
        runs = [_rf_cycle(c), _rf_cycle(c)]
    assert runs[0] and runs[1] and runs[0] != runs[1]
    for run in runs:
        rows = _rows(tmp_path, run)
        assert rows and all(r["part_roi"] == f"observed:{run}" for r in rows)


def test_cockpit_record_failure_never_costs_the_telemetry_row(tmp_path):
    with _client(tmp_path) as c:
        def boom():
            raise RuntimeError("cockpit bug")

        c.app.state.cockpit.record_fields = boom
        run = _rf_cycle(c)
    rows = _rows(tmp_path, run)
    assert rows and all(r["forward_w"] != "" for r in rows)  # core telemetry is still there
    assert all(r["shadow_k"] == "" for r in rows)  # the cockpit extras are blank, not junk


def test_observer_failure_log_is_rate_limited(tmp_path, caplog):
    with _client(tmp_path) as c:
        ticks = []
        c.app.state.controller.add_listener(lambda _snap: ticks.append(1))

        def boom(**_kw):
            raise RuntimeError("observer bug")

        with caplog.at_level(logging.ERROR, logger="tc_power_interface.api.app"):
            c.app.state.cockpit.observe = boom
            assert _wait_for(lambda: len(ticks) >= 12, timeout_s=3.0)  # >= 10 failing ticks
        failures = [r for r in caplog.records if "cockpit observer failed" in r.getMessage()]
    assert len(failures) == 1


def test_roi_roster_is_read_once_per_tick(tmp_path):
    """thermal_extra (a locked copy of the FLIR roster) is built once per tick and shared by the
    observer and the recorder, not rebuilt for each."""
    with _client(tmp_path) as c:
        reads = []
        ticks = []
        c.app.state.thermal.source.latest_roi_temps = lambda: reads.append(1) or [
            {"name": "toroid_C", "mean_c": 30.0, "valid": True}
        ]
        c.post("/api/rf/enable")  # recording on, so the recorder listener builds its row
        _wait_for(lambda: c.get("/api/recording/status").json()["active"], timeout_s=2.0)
        c.app.state.controller.add_listener(lambda _snap: ticks.append(1))
        reads.clear()
        time.sleep(0.5)
        n_ticks, n_reads = len(ticks), len(reads)
        c.post("/api/rf/disable")
    assert n_ticks >= 5
    assert n_reads <= n_ticks + 1  # was 2 per tick (observer + recorder)
