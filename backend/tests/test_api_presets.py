"""Tests for the software tuner-cap presets API (save/list/recall/delete, bad-slot rejection)."""

from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app


def _client(tmp_path):
    return TestClient(
        create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path)
    )


def test_presets_empty_has_nine_slots(tmp_path):
    with _client(tmp_path) as c:
        b = c.get("/api/presets").json()
        assert b["num_slots"] == 9
        assert b["slots"]["1"] is None


def test_save_then_recall(tmp_path):
    with _client(tmp_path) as c:
        r = c.put("/api/presets/3", json={"tune": 42, "load": 61})
        assert r.status_code == 200
        assert r.json()["slots"]["3"] == {"tune_cap_percent": 42, "load_cap_percent": 61}
        rec = c.post("/api/presets/3/recall").json()
        assert rec["applied"] == {"tune_cap_percent": 42, "load_cap_percent": 61}
        # exposed in the status block too
        assert c.get("/api/status").json()["presets"]["slots"]["3"]["tune_cap_percent"] == 42


def test_recall_empty_slot_is_noop(tmp_path):
    with _client(tmp_path) as c:
        assert c.post("/api/presets/5/recall").json()["applied"] is None


def test_bad_slot_rejected(tmp_path):
    with _client(tmp_path) as c:
        assert c.put("/api/presets/0", json={"tune": 1, "load": 1}).status_code == 400
        assert c.put("/api/presets/10", json={"tune": 1, "load": 1}).status_code == 400


def test_delete_clears_slot(tmp_path):
    with _client(tmp_path) as c:
        c.put("/api/presets/4", json={"tune": 10, "load": 20})
        c.delete("/api/presets/4")
        assert c.get("/api/presets").json()["slots"]["4"] is None
