from tc_power_interface.integration.rf_link_notifier import RfLinkNotifier


class FakeLink:
    def __init__(self):
        self.calls = []

    def notify(self, *, state, forward_w, reflected_fraction, reason):
        self.calls.append((state, reason))


def snap(rf_on, state="connected", fault=None, fwd=0.0):
    return {"state": state, "fault_reasons": fault or [],
            "telemetry": {"rf_on": rf_on, "forward_w": fwd, "reflected_fraction": 0.0}}


def test_rising_edge_emits_on():
    link = FakeLink()
    n = RfLinkNotifier(link)
    n.on_snapshot(snap(rf_on=False))
    n.on_snapshot(snap(rf_on=True, fwd=150.0))
    assert link.calls == [("on", "operator")]


def test_no_edge_no_emit():
    link = FakeLink()
    n = RfLinkNotifier(link)
    n.on_snapshot(snap(rf_on=True))
    n.on_snapshot(snap(rf_on=True))
    assert link.calls == []


def test_falling_edge_operator_reason():
    link = FakeLink()
    n = RfLinkNotifier(link)
    n.on_snapshot(snap(rf_on=True))
    n.on_snapshot(snap(rf_on=False))
    assert link.calls == [("off", "operator")]


def test_falling_edge_fault_reason():
    link = FakeLink()
    n = RfLinkNotifier(link)
    n.on_snapshot(snap(rf_on=True))
    n.on_snapshot(snap(rf_on=False, state="fault", fault=["reflected fraction 0.5 > 0.1"]))
    assert link.calls[0][0] == "off"
    assert "fault:" in link.calls[0][1]


def test_missing_telemetry_ignored():
    link = FakeLink()
    n = RfLinkNotifier(link)
    n.on_snapshot({"state": "connected", "fault_reasons": [], "telemetry": None})
    assert link.calls == []
