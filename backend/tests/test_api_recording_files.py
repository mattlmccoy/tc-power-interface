"""Run-file listing/download, run-folder paths and the reveal-in-file-browser route."""

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app


@pytest.fixture
def env(tmp_path):
    app = create_app(backend="simulated", poll_interval_s=0.05, experiments_root=tmp_path)
    launched: list[list[str]] = []
    app.state.reveal_launcher = launched.append
    with TestClient(app) as c:
        run = c.post("/api/recording/start", json={"name": "files"}).json()["run"]
        c.post("/api/recording/stop")
        d = tmp_path / run
        (d / "scope.csv").write_text("a,b\n1,2\n")
        (d / "scope_session.json").write_text("{}")
        (d / "scope_waveforms").mkdir()
        (d / "scope_waveforms" / "50W.csv").write_text("t,v\n")
        (d / "scope_waveforms" / "evil.csv").write_text("x")
        (tmp_path / "secret.txt").write_text("nope")
        yield c, run, d, launched


def test_list_files_reports_only_existing_whitelisted(env):
    c, run, _d, _ = env
    files = c.get(f"/api/recordings/{run}/files").json()["files"]
    assert set(files) == {"telemetry.csv", "scope.csv", "scope_session.json", "events.json",
                          "manifest.json", "metadata.json", "scope_waveforms/50W.csv"}


def test_download_scope_csv(env):
    c, run, _d, _ = env
    r = c.get(f"/api/recordings/{run}/files/scope.csv")
    assert r.status_code == 200 and r.text == "a,b\n1,2\n"
    assert f"{run}_scope.csv" in r.headers["content-disposition"]


def test_download_waveform(env):
    c, run, _d, _ = env
    r = c.get(f"/api/recordings/{run}/files/scope_waveforms/50W.csv")
    assert r.status_code == 200
    assert f"{run}_50W.csv" in r.headers["content-disposition"]


@pytest.mark.parametrize("path", [
    "..%2Fmetadata.json", "../metadata.json", "..%2F..%2Fsecret.txt", "%2Fetc%2Fpasswd",
    "foo.txt", "scope_waveforms/evil.csv", "scope_waveforms/..%2F..%2Fsecret.txt",
    "scope_waveforms/50W.csv/x",
])
def test_download_rejects_traversal_and_non_whitelisted(env, path):
    c, run, _d, _ = env
    assert c.get(f"/api/recordings/{run}/files/{path}").status_code in (400, 404)


def test_non_whitelisted_is_400_and_missing_is_404(env):
    c, run, _d, _ = env
    assert c.get(f"/api/recordings/{run}/files/foo.txt").status_code == 400
    assert c.get(f"/api/recordings/{run}/files/scope_levels.csv").status_code == 404
    assert c.get("/api/recordings/nope/files/scope.csv").status_code == 404
    assert c.get("/api/recordings/nope/files").status_code == 404


def test_bad_run_names_rejected(env):
    c, _run, _d, _ = env
    assert c.get("/api/recordings/..%2Fx/files").status_code in (400, 404)
    assert c.get("/api/recordings/../files").status_code in (400, 404)
    assert c.get("/api/recordings/..%2Fx/files/scope.csv").status_code in (400, 404)


def test_status_and_list_expose_paths(env, tmp_path):
    c, run, d, _ = env
    st = c.get("/api/status").json()["recording"]
    assert st["run_path"] is None and st["experiments_root"] == str(tmp_path.resolve())
    assert c.get("/api/recordings").json()["runs"][0]["path"] == str(d.resolve())
    r2 = c.post("/api/recording/start", json={"name": "live"}).json()["run"]
    assert c.get("/api/status").json()["recording"]["run_path"] == str((tmp_path / r2).resolve())
    c.post("/api/recording/stop")


def test_reveal_invokes_launcher_with_run_dir(env):
    c, run, d, launched = env
    r = c.post(f"/api/recordings/{run}/reveal")
    assert r.status_code == 200 and r.json() == {"ok": True, "path": str(d.resolve())}
    assert len(launched) == 1 and str(d.resolve()) in launched[0]


def test_reveal_rejects_traversal_and_missing(env):
    c, _run, _d, launched = env
    assert c.post("/api/recordings/..%2Fx/reveal").status_code in (400, 404, 405)
    assert c.post("/api/recordings/nope/reveal").status_code == 404
    assert launched == []


def test_reveal_cross_origin_needs_client_header(env):
    c, run, _d, launched = env
    r = c.post(f"/api/recordings/{run}/reveal", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403 and launched == []


def test_reveal_argv_per_platform():
    from tc_power_interface.api.recording_files import reveal_argv

    p = Path("/x/run")
    assert reveal_argv(p, "darwin") == ["open", "-R", str(p)]
    assert reveal_argv(p, "win32") == ["explorer", "/select,", str(p)]
    assert reveal_argv(p, "linux") == ["xdg-open", str(p)]


def test_metadata_json_is_valid(env):
    c, run, _d, _ = env
    assert json.loads(c.get(f"/api/recordings/{run}/files/metadata.json").text)
