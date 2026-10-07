"""Idle observer: with NO generator polling (backend "none", or after a link-loss disconnect) the
FLIR control temperature and the watched cores are still observed, so the cockpit never shows
temp_status "ok" with no number or "nothing watched" while cores are configured (real-data finding
2026-10-07). It is observe-only: it never actuates, never records, never posts to FLIR, and stays
silent while the generator's poll ticks are arriving (no double ticking)."""

import json
import logging
import time
from pathlib import Path

from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app
from tc_power_interface.integration.flir_roi_temps import FlirPollingSource

POLL_S = 0.05

#: Captured from the LIVE FLIR endpoint (real A70, 11 ROIs, room temperature) on 2026-10-07.
_LIVE = json.loads(
    (Path(__file__).parent / "fixtures" / "flir_roi_temps_live_20261007.json").read_text()
)
_MEAN = {r["name"]: r["mean_c"] for r in _LIVE["rois"]}


def _flir_stub(roi_name: str = "freehand_sample") -> FlirPollingSource:
    """The real FlirPollingSource, fed the captured payload through its injectable GET (no HTTP,
    no background thread): read()/status/latest_roi_temps() are exactly what the operator sees."""
    src = FlirPollingSource("http://flir.invalid/api/live/roi-temps", roi_name=roi_name,
                            _get=lambda _url, _timeout: _LIVE)
    src.poll_once()
    return src


def _client(tmp_path, backend="none"):
    return TestClient(
        create_app(backend=backend, poll_interval_s=POLL_S, experiments_root=tmp_path)
    )


def _wait_for(fn, timeout_s=1.0):
    deadline = time.monotonic() + timeout_s
    value = fn()
    while not value and time.monotonic() < deadline:
        time.sleep(0.02)
        value = fn()
    return value


def _thermal(c):
    return c.get("/api/status").json()["thermal"]


def _configure(c):
    c.app.state.thermal.source = _flir_stub()
    assert c.post("/api/thermal/roi", json={"name": "freehand_sample"}).status_code == 200
    assert c.post("/api/thermal/watch", json={"names": ["toroid_C", "toroid_D"]}).status_code == 200


def test_no_generator_still_observes_control_temp_and_watched_cores(tmp_path):
    with _client(tmp_path) as c:
        _configure(c)
        th = _wait_for(
            lambda: (t := _thermal(c))["control_temp_c"] is not None and t["watch"] and t
        )
        assert th, f"never observed with no generator: {_thermal(c)}"
        assert th["temp_status"] == "ok"
        assert th["control_temp_c"] == round(_MEAN["freehand_sample"], 1)
        watch = {w["name"]: w for w in th["watch"]}
        assert list(watch) == ["toroid_C", "toroid_D"]
        assert watch["toroid_C"]["temp_c"] == _MEAN["toroid_C"]
        assert watch["toroid_D"]["temp_c"] == _MEAN["toroid_D"]
        assert all(w["status"] == "ok" for w in watch.values())


def test_no_double_ticking_while_the_generator_polls(tmp_path):
    with _client(tmp_path, backend="simulated") as c:
        thermal = c.app.state.thermal
        ticks, observes = [], []
        real_tick = thermal.tick
        thermal.tick = lambda dt: ticks.append(1) or real_tick(dt)
        real_observe = thermal.observe
        thermal.observe = lambda dt: observes.append(1) or real_observe(dt)
        polls = []
        c.app.state.controller.add_listener(lambda _snap: polls.append(1))
        time.sleep(1.0)
        n_polls, n_ticks, n_observes = len(polls), len(ticks), len(observes)
    assert n_polls >= 10  # the generator really was polling
    assert abs(n_ticks - n_polls) <= 1  # one thermal tick per poll, not two
    assert n_observes == 0  # the idle observer stayed silent


def test_idle_path_never_actuates_records_or_posts(tmp_path):
    class _Poster:  # stands in for the FLIR control-telemetry poster / rf-link
        enabled = True

        def __init__(self):
            self.bodies = []

        def post(self, body):
            self.bodies.append(body)

    with _client(tmp_path) as c:
        calls = []
        ctrl = c.app.state.controller
        for name in ("set_setpoint", "enable_rf", "disable_rf", "estop", "set_manual_mode",
                     "set_tune_capacity", "set_load_capacity"):
            setattr(ctrl, name, lambda *a, _n=name, **k: calls.append(_n))
        recorder = c.app.state.recorder
        recorder.record = lambda *a, **k: calls.append("record")
        poster = _Poster()
        c.app.state.control_telemetry = poster
        flir_posts = []
        c.app.state.flir_link.notify = lambda **k: flir_posts.append(k)
        thermal = c.app.state.thermal
        thermal.mode = "auto"  # the strongest case: a started auto loop with no generator
        thermal.start()
        _configure(c)
        observed = []
        cockpit = c.app.state.cockpit
        real_observe = cockpit.observe
        cockpit.observe = lambda **kw: observed.append(kw) or real_observe(**kw)
        time.sleep(1.0)
    assert len(observed) >= 5  # non-vacuous: the idle path really ran
    assert all(kw["telemetry"] == {} for kw in observed)  # no telemetry: RF off, 0 W
    assert calls == [] and poster.bodies == [] and flir_posts == []


def test_idle_failure_is_logged_once_and_the_loop_keeps_going(tmp_path, caplog):
    with _client(tmp_path) as c:
        _configure(c)
        src = c.app.state.thermal.source
        good_read = src.read

        def boom():
            raise RuntimeError("source bug")

        with caplog.at_level(logging.ERROR, logger="tc_power_interface.api.app"):
            src.read = boom
            c.app.state.thermal.control_temp_c = None
            time.sleep(0.6)  # ~6 idle periods, every one failing
            failures = [r for r in caplog.records if "idle observer failed" in r.getMessage()]
            assert len(failures) == 1  # rate-limited, but never silent
            src.read = good_read  # the bug goes away: the loop is still alive and recovers
            assert _wait_for(lambda: _thermal(c)["control_temp_c"] is not None)


def test_a_slow_generator_read_never_lets_the_idle_observer_in(tmp_path):
    """A real AG read is ~1 s (three CXN round-trips) against a 0.5 s poll, so the gap between
    poll ticks routinely exceeds 2 x poll_interval. The idle observer must still stay silent while
    the generator is attached and polling — otherwise it would feed the cockpit RF-off/0 W rows in
    the middle of a live RF run."""
    with _client(tmp_path, backend="simulated") as c:
        dev = c.app.state.controller.device
        real_read = dev.read_telemetry

        def slow_read():
            time.sleep(4 * POLL_S)
            return real_read()

        dev.read_telemetry = slow_read
        thermal = c.app.state.thermal
        observes = []
        real_observe = thermal.observe
        thermal.observe = lambda dt: observes.append(1) or real_observe(dt)
        time.sleep(1.0)
    assert observes == []


def test_after_a_disconnect_the_idle_observer_takes_over(tmp_path):
    with _client(tmp_path, backend="simulated") as c:
        _configure(c)
        assert c.post("/api/disconnect").status_code == 200
        thermal = c.app.state.thermal
        thermal.control_temp_c = None  # forget the last polled reading
        expected = round(_MEAN["freehand_sample"], 1)
        assert _wait_for(lambda: _thermal(c)["control_temp_c"] == expected)
