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


# --- command-driven notification (bench finding 2026-09-08: a quick RF on/off shorter than the
# 0.5 s telemetry poll was invisible to the edge detector, so FLIR never got the event) ----------


def test_command_emits_immediately_and_dedupes_the_following_telemetry_edge():
    link = FakeLink()
    n = RfLinkNotifier(link)
    n.on_snapshot(snap(rf_on=False))  # baseline
    n.on_command(on=True)
    assert link.calls == [("on", "operator")]  # sent at once, not after the next poll
    n.on_snapshot(snap(rf_on=True))  # the sampler confirms it -> NOT sent a second time
    assert link.calls == [("on", "operator")]
    n.on_command(on=False)
    assert link.calls == [("on", "operator"), ("off", "operator")]
    n.on_snapshot(snap(rf_on=False))  # confirmation of off -> deduped too
    assert len(link.calls) == 2


def test_sub_poll_pulse_is_reported_by_commands_even_if_telemetry_never_sees_it():
    link = FakeLink()
    n = RfLinkNotifier(link)
    n.on_snapshot(snap(rf_on=False))
    n.on_command(on=True)
    n.on_command(on=False)  # on -> off faster than one poll
    n.on_snapshot(snap(rf_on=False))  # the sampler never saw rf_on=True
    assert link.calls == [("on", "operator"), ("off", "operator")]


def test_front_panel_edge_without_a_command_still_emits():
    # A change not made through our API (front panel) is still caught by the telemetry edge.
    link = FakeLink()
    n = RfLinkNotifier(link)
    n.on_snapshot(snap(rf_on=False))
    n.on_snapshot(snap(rf_on=True))
    assert link.calls == [("on", "operator")]


def test_command_reason_is_passed_through():
    link = FakeLink()
    n = RfLinkNotifier(link)
    n.on_snapshot(snap(rf_on=True))
    n.on_command(on=False, reason="e-stop")
    assert link.calls == [("off", "e-stop")]


def test_fault_off_edge_after_a_commanded_on_carries_the_fault_reason():
    # We announced RF on via the command; protection then trips it off -> FLIR must get the fault.
    link = FakeLink()
    n = RfLinkNotifier(link)
    n.on_snapshot(snap(rf_on=False))
    n.on_command(on=True)
    n.on_snapshot(snap(rf_on=True))  # deduped confirmation
    n.on_snapshot(snap(rf_on=False, state="fault", fault=["reflected fraction 0.5 > 0.1"]))
    assert link.calls[-1][0] == "off"
    assert "fault:" in link.calls[-1][1]
