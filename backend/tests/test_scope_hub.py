import time
from dataclasses import replace

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


class _AnyChannel(FakeScope):
    """Answers C1 or C2 queries with the real capture's replies and logs every query."""

    log: list[str] = []

    def query(self, cmd: str) -> str:
        _AnyChannel.log.append(cmd)
        return super().query(cmd.replace("C2:", "C1:"))


def test_channel_change_while_connected_restarts_the_link(tmp_path, monkeypatch):
    import tc_power_interface.integration.scope_hub as hub_mod

    _AnyChannel.log = []
    monkeypatch.setattr(hub_mod, "open_visa", lambda _r: _AnyChannel())
    hub, _ = _hub(tmp_path, resource="USB0::fake", poll_interval_s=0.05)
    hub.connect()
    assert _wait(lambda: "C1:ATTN?" in _AnyChannel.log)
    hub.update_settings(replace(hub.settings, channel=2))
    ok = _wait(lambda: "C2:ATTN?" in _AnyChannel.log)
    running = hub.link.status()["running"]
    hub.disconnect()
    assert ok and running


def test_unrelated_setting_change_keeps_an_assigned_level(tmp_path):
    hub, _ = _hub(tmp_path, settle_s=0.2)
    snap = {"last_setpoint_w": 50.0, "telemetry": {"forward_w": 50.0, "rf_on": True}}
    hub.on_snapshot(snap)
    time.sleep(0.25)
    hub.on_snapshot(snap)
    assert hub._ctx["level_state"] == "assigned"
    hub.update_settings(replace(hub.settings, core_label="core 3"))
    hub.on_snapshot(snap)
    assert hub._ctx["level_state"] == "assigned"  # tracker not rebuilt for a label edit
    hub.update_settings(replace(hub.settings, settle_s=5.0))
    hub.on_snapshot(snap)
    assert hub._ctx["level_state"] == "settling"  # but rebuilt when settling rules change


def test_save_failure_leaves_hub_settings_unchanged(tmp_path, monkeypatch):
    import pytest

    import tc_power_interface.integration.scope_hub as hub_mod

    hub, _ = _hub(tmp_path, core_label="core 2")

    def boom(*_a, **_k):
        raise OSError("disk full")

    monkeypatch.setattr(hub_mod, "save_settings", boom)
    with pytest.raises(OSError):
        hub.update_settings(replace(hub.settings, core_label="core 9", settle_s=9.0))
    assert hub.settings.core_label == "core 2" and hub._tracker.settle_s == 3.0


def test_flagger_resets_on_new_run_and_on_probe_or_geometry_change(tmp_path):
    hub, rec = _hub(tmp_path)
    f0 = hub._flagger
    hub.update_settings(replace(hub.settings, core_label="x"))
    assert hub._flagger is f0  # unrelated edit keeps per-session history
    hub.update_settings(replace(hub.settings, probe_attn=10.0))
    f1 = hub._flagger
    assert f1 is not f0
    hub.update_settings(replace(hub.settings, geometry=replace(hub.settings.geometry, turns=2)))
    f2 = hub._flagger
    assert f2 is not f1
    rec.start("t", {})
    hub.on_reading(_reading())
    assert hub._flagger is not f2  # a new run starts a new heuristic session
    rec.stop()


def test_attn_mismatch_event_carries_both_attenuations(tmp_path):
    hub, rec = _hub(tmp_path, probe_attn=500)
    rec.start("t", {})
    hub.on_reading(_reading())
    ev = next(e for e in rec._events if e["label"] == "scope_attn_mismatch")
    rec.stop()
    assert ev["data"]["attn"] == 50.0 and ev["data"]["probe_attn"] == 500.0


def test_reading_without_fit_has_none_values_and_is_invalid(tmp_path):
    hub, _ = _hub(tmp_path)
    r = _reading()
    hub.on_reading(Reading(r.host_timestamp_ns, r.capture, None))
    latest = hub._latest
    assert latest is not None and latest["valid"] is False
    assert all(latest[k] is None for k in ("vrms_v", "f0_hz", "resid_v", "h2_pct", "h3_pct",
                                           "b_pk_mt"))
    assert latest["vmin_v"] is not None  # raw-capture stats still reported


def test_clipped_reading_raises_clipped_event(tmp_path):
    hub, rec = _hub(tmp_path)
    rec.start("t", {})
    r = _reading()
    hub.on_reading(Reading(r.host_timestamp_ns, replace(r.capture, clipped=True), None))
    labels = [e["label"] for e in rec._events]
    rec.stop()
    assert "scope_clipped" in labels


def test_link_error_shows_no_data(tmp_path, monkeypatch):
    scopes = [FakeScope(fail_after=1)] + [FakeScope(fail_after=0) for _ in range(50)]
    hub, _ = _live_hub(tmp_path, monkeypatch, scopes)
    hub.connect()
    assert _wait(lambda: hub.link.status()["error"] is not None)
    snap = hub.snapshot()
    hub.disconnect()
    assert snap["status"]["connected"] is False and snap["latest"] is None
