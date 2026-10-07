import time

import pytest
from fastapi.testclient import TestClient
from scope_fakes import FakeScope

from tc_power_interface.api.app import create_app
from tc_power_interface.control.controller import Controller

COMMANDS = ("set_setpoint", "disable_rf", "enable_rf", "estop", "set_tune_capacity",
            "set_load_capacity", "set_manual_mode", "arm", "disarm")


def _app(tmp_path, monkeypatch):
    import tc_power_interface.integration.scope_hub as hub_mod

    monkeypatch.setattr(hub_mod, "open_visa", lambda _r: FakeScope())
    return create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path)


def _wait_latest(c, timeout=3.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        latest = c.get("/api/status").json()["scope"]["latest"]
        if latest is not None:
            return latest
        time.sleep(0.05)
    return None


def test_status_has_scope_block_with_no_data_when_disconnected(tmp_path, monkeypatch):
    with TestClient(_app(tmp_path, monkeypatch)) as c:
        sc = c.get("/api/status").json()["scope"]
        assert sc["status"]["connected"] is False
        assert sc["latest"] is None  # never zeros


def test_connect_streams_readings_and_records_into_run(tmp_path, monkeypatch):
    with TestClient(_app(tmp_path, monkeypatch)) as c:
        assert c.post("/api/scope/settings", json={"resource": "USB0::fake"}).status_code == 200
        # start the run first so the first reading is guaranteed to land inside it
        r = c.post("/api/recording/start", json={"name": "scope-test"})
        assert r.status_code == 200
        assert c.post("/api/scope/connect").status_code == 200
        latest = _wait_latest(c)
        assert latest is not None
        assert abs(latest["vrms_v"] - 50.149) < 0.05
        assert latest["level_state"] in ("rf_off", "no_setpoint")
        c.post("/api/recording/stop")
        c.post("/api/scope/disconnect")
        assert c.get("/api/scope").json()["latest"] is None  # disconnected -> no data again
    runs = [p for p in tmp_path.iterdir() if p.is_dir()]
    assert len(runs) == 1
    assert (runs[0] / "scope.csv").exists() and (runs[0] / "scope_levels.csv").exists()
    assert "scope.csv" in (runs[0] / "manifest.json").read_text()


def test_attn_mismatch_is_flagged(tmp_path, monkeypatch):
    with TestClient(_app(tmp_path, monkeypatch)) as c:
        c.post("/api/scope/settings", json={"resource": "USB0::fake", "probe_attn": 500})
        c.post("/api/scope/connect")
        latest = _wait_latest(c)
        assert latest is not None
        assert "attn_mismatch" in latest["flags"]
        assert latest["valid"] is False
        c.post("/api/scope/disconnect")


def test_connect_without_resource_is_409(tmp_path, monkeypatch):
    with TestClient(_app(tmp_path, monkeypatch)) as c:
        assert c.post("/api/scope/connect").status_code == 409


def test_settings_deep_merge_and_persist(tmp_path, monkeypatch):
    with TestClient(_app(tmp_path, monkeypatch)) as c:
        body = {"geometry": {"turns": 2}, "limits": {"flux_stop_mt": 5.0}}
        r = c.post("/api/scope/settings", json=body)
        assert r.status_code == 200
        s = r.json()["settings"]
        assert s["geometry"]["turns"] == 2 and s["geometry"]["cores_linked"] == 1
        assert s["limits"]["flux_stop_mt"] == 5.0 and s["limits"]["probe_warn_v"] == 65.0
    with TestClient(_app(tmp_path, monkeypatch)) as c:  # reloaded from scope_settings.json
        assert c.get("/api/scope").json()["settings"]["geometry"]["turns"] == 2


def test_bad_settings_are_422_and_not_saved(tmp_path, monkeypatch):
    with TestClient(_app(tmp_path, monkeypatch)) as c:
        body = {"limits": {"probe_warn_v": 80, "probe_hard_v": 70}}
        bad = c.post("/api/scope/settings", json=body)
        assert bad.status_code == 422
        assert c.post("/api/scope/settings", json={"geometry": {"bogus": 1}}).status_code == 422
        assert c.get("/api/scope").json()["settings"]["limits"]["probe_warn_v"] == 65.0


def test_scope_path_never_commands_the_generator(tmp_path, monkeypatch):
    """Warn-only: a full scope session (connect, readings, flags, record, disconnect) must not
    invoke any Controller command. Spies wrap the real methods, so other app paths still work."""
    calls: list[str] = []
    for name in COMMANDS:
        orig = getattr(Controller, name)

        def spy(self, *a, _n=name, _o=orig, **kw):
            calls.append(_n)
            return _o(self, *a, **kw)

        monkeypatch.setattr(Controller, name, spy)
    with TestClient(_app(tmp_path, monkeypatch)) as c:
        calls.clear()  # ignore anything the app does at startup
        c.post("/api/scope/settings", json={"resource": "USB0::fake", "probe_attn": 500,
                                            "limits": {"probe_warn_v": 1, "probe_hard_v": 2,
                                                       "flux_stop_mt": 0.1}})
        c.post("/api/recording/start", json={"name": "warn-only"})
        c.post("/api/scope/connect")
        latest = _wait_latest(c)
        assert latest is not None
        assert {"probe_hard", "flux_stop", "attn_mismatch"} <= set(latest["flags"].split(";"))
        c.post("/api/recording/stop")
        c.post("/api/scope/disconnect")
        assert calls == []
    run = next(p for p in tmp_path.iterdir() if p.is_dir())
    assert "scope_probe_hard" in (run / "events.json").read_text()  # warned, not acted on


BAD_SETTINGS = [
    {"probe_attn": "abc"},
    {"probe_attn": 0},
    {"channel": 3},
    {"channel": "one"},
    {"poll_interval_s": 0},
    {"tol_w": -1},
    {"settle_s": -0.5},
    {"geometry": {"turns": "x"}},
    {"geometry": "not-a-dict"},
    {"limits": {"flux_stop_mt": "high"}},
    {"resource": 5},
    {"probe_atn": 50},  # typo of a real key: rejected, never silently ignored
]


@pytest.mark.parametrize("body", BAD_SETTINGS)
def test_bad_typed_settings_are_422_and_change_nothing(tmp_path, monkeypatch, body):
    with TestClient(_app(tmp_path, monkeypatch)) as c:
        before = c.get("/api/scope").json()["settings"]
        assert c.post("/api/scope/settings", json=body).status_code == 422
        assert c.get("/api/scope").json()["settings"] == before
    assert not (tmp_path / "scope_settings.json").exists()


def test_numeric_strings_are_coerced(tmp_path, monkeypatch):
    with TestClient(_app(tmp_path, monkeypatch)) as c:
        body = {"probe_attn": "500", "channel": "2", "geometry": {"turns": "2"},
                "limits": {"flux_stop_mt": "5.5"}}
        r = c.post("/api/scope/settings", json=body)
        assert r.status_code == 200
        s = r.json()["settings"]
        assert s["probe_attn"] == 500.0 and s["channel"] == 2
        assert s["geometry"]["turns"] == 2 and s["limits"]["flux_stop_mt"] == 5.5
