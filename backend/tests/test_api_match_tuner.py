"""Tests for the match-tuner API (config/bounds, status block, start/arm/stop, estop stops it)."""

from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app


def _client(tmp_path):
    return TestClient(
        create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path)
    )


def test_config_exposes_bounds_and_defaults(tmp_path):
    with _client(tmp_path) as c:
        b = c.get("/api/match-tuner").json()
        assert b["mode"] == "advisory"
        assert "tune_step" in b["bounds"]


def test_status_has_match_tuner_block(tmp_path):
    with _client(tmp_path) as c:
        s = c.get("/api/status").json()["match_tuner"]
        assert s["running"] is False and s["armed"] is False


def test_start_arm_stop(tmp_path):
    with _client(tmp_path) as c:
        assert c.post("/api/match-tuner/start").json()["running"] is True
        assert c.post("/api/match-tuner/arm").json()["armed"] is True
        assert c.post("/api/match-tuner/stop").json()["running"] is False


def test_put_clamps_out_of_range_steps(tmp_path):
    with _client(tmp_path) as c:
        r = c.put(
            "/api/match-tuner",
            json={"mode": "auto", "tune_step": 99.0, "load_step": 0.0, "guard": 5.0},
        )
        assert r.status_code == 200
        b = r.json()
        assert b["mode"] == "auto"
        assert b["tune_step"] == b["bounds"]["tune_step"][1]
        assert b["load_step"] == b["bounds"]["load_step"][0]


def test_estop_stops_the_match_tuner(tmp_path):
    with _client(tmp_path) as c:
        c.post("/api/match-tuner/start")
        c.post("/api/match-tuner/arm")
        assert c.get("/api/status").json()["match_tuner"]["running"] is True
        c.post("/api/estop")
        s = c.get("/api/status").json()["match_tuner"]
        assert s["running"] is False and s["armed"] is False
