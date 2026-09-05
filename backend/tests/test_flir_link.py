from tc_power_interface.integration.flir_link import FlirLink, build_payload


def test_build_payload_on():
    p = build_payload(state="on", forward_w=300.0, reflected_fraction=0.01, reason="operator")
    assert p == {"state": "on", "forward_w": 300.0, "reflected_fraction": 0.01,
                 "reason": "operator"}


def test_disabled_link_does_not_post():
    calls = []
    link = FlirLink(url="http://localhost:8000", enabled=False,
                    _post=lambda url, body, timeout: calls.append(url))
    link.notify(state="on", forward_w=300.0, reflected_fraction=0.01, reason="operator")
    link.join()
    assert calls == []
    assert link.last_result["ok"] is None  # never attempted


def test_enabled_link_posts_and_records_success():
    calls = []
    link = FlirLink(url="http://localhost:8000", enabled=True,
                    _post=lambda url, body, timeout: calls.append((url, body)))
    link.notify(state="off", forward_w=0.0, reflected_fraction=0.0, reason="fault: arc")
    link.join()
    assert calls[0][0] == "http://localhost:8000/api/rf-link/event"
    assert calls[0][1]["reason"] == "fault: arc"
    assert link.last_result["ok"] is True


def test_post_failure_is_swallowed_and_recorded():
    def boom(url, body, timeout):
        raise OSError("connection refused")
    link = FlirLink(url="http://localhost:8000", enabled=True, _post=boom)
    link.notify(state="on", forward_w=1.0, reflected_fraction=0.0, reason="operator")
    link.join()
    assert link.last_result["ok"] is False
    assert "refused" in link.last_result["message"]
