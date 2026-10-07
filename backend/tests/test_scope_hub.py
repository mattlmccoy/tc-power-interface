import time

from scope_fakes import FakeScope

from tc_power_interface.analysis.sense_loop_fit import fit_sense_loop
from tc_power_interface.integration.scope_hub import ScopeHub
from tc_power_interface.integration.scope_link import Reading, acquire_once
from tc_power_interface.integration.scope_settings import ScopeSettings
from tc_power_interface.recording.recorder import TelemetryRecorder


def _reading() -> Reading:
    cap = acquire_once(FakeScope(), channel=1)
    return Reading(1, cap, fit_sense_loop(cap.t, cap.volts))


def _hub(tmp_path, **settings):
    rec = TelemetryRecorder(tmp_path)
    hub = ScopeHub(tmp_path, rec)
    hub.update_settings(ScopeSettings(**settings))
    return hub, rec


def test_no_events_or_files_while_idle(tmp_path):
    hub, rec = _hub(tmp_path, probe_attn=500)  # attn_mismatch on every reading
    hub.on_reading(_reading())
    assert rec._events == []
    assert not any(p.is_dir() for p in tmp_path.iterdir())


def test_events_and_rows_only_inside_a_run(tmp_path):
    hub, rec = _hub(tmp_path, probe_attn=500)
    run = rec.start("t", {})
    hub.on_reading(_reading())
    assert [e["label"] for e in rec._events] == ["recording_started", "scope_attn_mismatch"]
    rec.stop()
    assert (run / "scope.csv").read_text().count("\n") == 2  # header + 1 row
    n = len(rec._events)
    hub.on_reading(_reading())  # after stop: no new events, no new run files
    assert len(rec._events) == n
    assert sorted(p.name for p in tmp_path.iterdir() if p.is_dir()) == [run.name]


def test_snapshot_feeds_level_context(tmp_path):
    hub, _ = _hub(tmp_path, settle_s=0.0)
    hub.on_snapshot({"last_setpoint_w": 50.0,
                     "telemetry": {"forward_w": 50.2, "rf_on": True, "reverse_w": 0.1,
                                   "tune_cap_percent": 40.0, "load_cap_percent": 60.0}})
    hub.on_reading(_reading())
    latest = hub._latest
    assert latest is not None
    assert latest["level_w"] == 50.0 and latest["level_state"] == "assigned"
    assert latest["setpoint_w"] == 50.0 and latest["forward_w"] == 50.2


def test_snapshot_without_telemetry_is_rf_off(tmp_path):
    hub, _ = _hub(tmp_path)
    hub.on_snapshot({"telemetry": None, "last_setpoint_w": None})
    hub.on_reading(_reading())
    assert hub._latest is not None and hub._latest["level_state"] == "rf_off"


def test_latest_hidden_when_link_not_connected(tmp_path):
    hub, _ = _hub(tmp_path)
    hub.on_reading(_reading())
    assert hub.snapshot()["latest"] is None


def test_flag_events_fire_on_onset_not_every_reading(tmp_path):
    hub, rec = _hub(tmp_path, probe_attn=500)
    rec.start("t", {})
    for _ in range(5):
        hub.on_reading(_reading())
    assert [e["label"] for e in rec._events].count("scope_attn_mismatch") == 1
    hub.update_settings(ScopeSettings(probe_attn=50))  # condition clears ...
    hub.on_reading(_reading())
    hub.update_settings(ScopeSettings(probe_attn=500))  # ... and returns: a new onset
    hub.on_reading(_reading())
    assert [e["label"] for e in rec._events].count("scope_attn_mismatch") == 2
    rec.stop()


def test_reading_racing_stop_does_not_reopen_finalized_run(tmp_path):
    hub, rec = _hub(tmp_path)
    run = rec.start("t", {})
    hub.on_reading(_reading())
    hub.on_reading(_reading())
    rec.stop()
    # simulate a reading that sampled run_dir just before stop(): must not truncate scope.csv
    hub._open_run(run)
    assert (run / "scope.csv").read_text().count("\n") == 3


class _StallAfter(FakeScope):
    """Delivers n readings, then read_raw stalls (USB hang) for stall_s."""

    def __init__(self, n: int, stall_s: float) -> None:
        super().__init__()
        self.n, self.stall_s = n, stall_s

    def read_raw(self) -> bytes:
        if self.reads >= self.n:
            time.sleep(self.stall_s)
        return super().read_raw()


def _wait(pred, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.01)
    return False


def _live_hub(tmp_path, monkeypatch, scopes):
    import tc_power_interface.integration.scope_hub as hub_mod

    monkeypatch.setattr(hub_mod, "open_visa", lambda _r: scopes.pop(0))
    hub, rec = _hub(tmp_path, resource="USB0::fake", poll_interval_s=0.05)
    hub.link._join_timeout_s = 0.05
    return hub, rec


def test_stalled_link_shows_no_data_not_the_last_reading(tmp_path, monkeypatch):
    import tc_power_interface.integration.scope_hub as hub_mod

    monkeypatch.setattr(hub_mod, "STALE_MIN_S", 0.3, raising=False)
    hub, _ = _live_hub(tmp_path, monkeypatch, [_StallAfter(1, 3.0)])
    hub.connect()
    assert _wait(lambda: hub.snapshot()["latest"] is not None)
    time.sleep(0.5)  # > max(STALE_MIN_S, 5 x poll_interval_s)
    snap = hub.snapshot()
    hub.disconnect()
    assert snap["status"]["connected"] is True
    assert snap["latest"] is None
    assert snap["stale"] is True  # distinguishable from "no reading yet"


def test_reconnect_does_not_show_the_previous_sessions_reading(tmp_path, monkeypatch):
    hub, _ = _live_hub(tmp_path, monkeypatch, [FakeScope(), _StallAfter(0, 3.0)])
    hub.connect()
    assert _wait(lambda: hub.snapshot()["latest"] is not None)
    hub.disconnect()
    hub.connect()  # second session: connected, but no reading yet
    assert _wait(lambda: hub.snapshot()["status"]["connected"])
    snap = hub.snapshot()
    hub.disconnect()
    assert snap["latest"] is None
