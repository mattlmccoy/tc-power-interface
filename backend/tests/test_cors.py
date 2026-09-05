"""Cross-origin protection: a public (site-mode) UI may drive the LOCAL operator only with the
X-TCP-Client header; other websites cannot. Same model as the FLIR tool. This matters because
the operator can command RF hardware.
"""

import pytest
from fastapi.testclient import TestClient

from tc_power_interface.api.app import create_app


@pytest.fixture
def client(tmp_path):
    app = create_app(
        backend="simulated",
        poll_interval_s=0.05,
        experiments_root=tmp_path,
        site_origin="https://site.example",
    )
    with TestClient(app) as c:
        yield c


def test_cross_origin_write_without_client_header_is_forbidden(client):
    r = client.post("/api/rf/disable", headers={"Origin": "https://evil.example"})
    assert r.status_code == 403


def test_cross_origin_write_with_client_header_is_allowed(client):
    r = client.post(
        "/api/rf/disable",
        headers={"Origin": "https://site.example", "X-TCP-Client": "1"},
    )
    assert r.status_code == 200


def test_cross_origin_get_is_allowed_without_header(client):
    r = client.get("/api/health", headers={"Origin": "https://evil.example"})
    assert r.status_code == 200


def test_same_origin_write_is_allowed_without_header(client):
    r = client.post("/api/rf/disable")  # no Origin header -> not cross-origin
    assert r.status_code == 200
