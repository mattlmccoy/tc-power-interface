"""Run clock: a per-run RF-on-time reminder. Counts only while RF is on, warns at 2 min / 30 s,
counts overtime past zero. Display + record only: it never commands the generator."""

import pytest

from tc_power_interface.control.run_clock import FINAL_S, WARN_S, RunClock


def _feed(clock, start, stop, rf_on, step=0.5):
    """Feed polls every ``step`` s from ``start`` to ``stop`` (exclusive); returns all events."""
    events, t = [], start
    while t < stop - 1e-9:
        events += clock.update(t, rf_on)
        t += step
    return events


def _labels(events):
    return [label for label, _ in events]


def test_constants_are_the_agreed_ones():
    assert WARN_S == 120.0 and FINAL_S == 30.0


def test_unset_clock_reports_off():
    s = RunClock().snapshot(0.0)
    assert s["set"] is False and s["phase"] == "off" and s["remaining_s"] is None


def test_counts_only_rf_on_time():
    c = RunClock()
    assert _labels(c.set(600.0, 0.0)) == ["run_clock_set"]
    _feed(c, 0.0, 60.0, True)     # 60 s on
    _feed(c, 60.0, 180.0, False)  # 120 s off: paused
    _feed(c, 180.0, 210.0, True)  # 30 s on
    s = c.snapshot(210.0)
    assert s["on_s"] == pytest.approx(90.0, abs=0.6)
    assert s["remaining_s"] == pytest.approx(510.0, abs=0.6)
    assert s["counting"] is True and s["phase"] == "running"


def test_rf_off_shows_paused():
    c = RunClock()
    c.set(600.0, 0.0)
    _feed(c, 0.0, 10.0, True)
    _feed(c, 10.0, 20.0, False)
    s = c.snapshot(20.0)
    assert s["counting"] is False and s["phase"] == "paused"


def test_unknown_rf_state_never_counts():
    c = RunClock()
    c.set(600.0, 0.0)
    _feed(c, 0.0, 30.0, None)
    _feed(c, 30.0, 40.0, True)
    _feed(c, 40.0, 70.0, None)  # telemetry lost while RF was on: not counted
    assert c.snapshot(70.0)["on_s"] == pytest.approx(10.0, abs=0.6)


def test_snapshot_ticks_smoothly_between_polls():
    c = RunClock()
    c.set(600.0, 0.0)
    _feed(c, 0.0, 10.5, True)  # last poll at 10.0, RF on
    assert c.snapshot(10.25)["on_s"] == pytest.approx(10.25, abs=0.01)


def test_warn_final_and_over_fire_once_each_in_order():
    c = RunClock()
    c.set(150.0, 0.0)
    ev = _labels(_feed(c, 0.0, 200.0, True))
    assert ev == ["run_clock_warn", "run_clock_final", "run_clock_over"]
    s = c.snapshot(200.0)
    assert s["phase"] == "over" and s["remaining_s"] == pytest.approx(-50.0, abs=0.6)


def test_phases_by_remaining_time():
    c = RunClock()
    c.set(200.0, 0.0)
    _feed(c, 0.0, 90.0, True)  # 110 s left
    assert c.snapshot(90.0)["phase"] == "warn"
    _feed(c, 90.0, 175.0, True)  # 25 s left
    assert c.snapshot(175.0)["phase"] == "final"


def test_warning_while_paused_keeps_the_warning_phase_and_says_not_counting():
    c = RunClock()
    c.set(130.0, 0.0)
    _feed(c, 0.0, 20.0, True)  # 110 s left
    _feed(c, 20.0, 30.0, False)
    s = c.snapshot(30.0)
    assert s["phase"] == "warn" and s["counting"] is False


def test_adding_time_rearms_the_warnings():
    c = RunClock()
    c.set(150.0, 0.0)
    _feed(c, 0.0, 160.0, True)  # over by 10 s
    ev = c.add(300.0)
    assert ev == [("run_clock_extended", {"target_s": 450.0, "added_s": 300.0})]
    s = c.snapshot(160.0)
    assert s["phase"] == "running" and s["dismissed"] is False
    rearmed = _labels(_feed(c, 160.0, 460.0, True))
    assert rearmed == ["run_clock_warn", "run_clock_final", "run_clock_over"]


def test_dismiss_only_when_over_and_records_the_overtime():
    c = RunClock()
    c.set(60.0, 0.0)
    assert c.dismiss(0.0) == []  # nothing to dismiss yet
    _feed(c, 0.0, 70.0, True)
    ev = c.dismiss(70.0)
    assert _labels(ev) == ["run_clock_dismissed"]
    assert ev[0][1]["over_s"] == pytest.approx(10.0, abs=0.6)
    s = c.snapshot(80.0)
    assert s["dismissed"] is True and s["phase"] == "over"  # still shows the overtime


def test_cancel_clears_and_records_what_ran():
    c = RunClock()
    c.set(600.0, 0.0)
    _feed(c, 0.0, 30.0, True)
    ev = c.cancel(30.0)
    assert ev[0][0] == "run_clock_cancelled"
    assert ev[0][1]["target_s"] == 600.0 and ev[0][1]["on_s"] == pytest.approx(30.0, abs=0.6)
    assert c.snapshot(31.0)["phase"] == "off"
    assert c.cancel(31.0) == []  # cancelling nothing records nothing
    assert c.add(60.0) == []  # nothing to extend


def test_setting_again_starts_over():
    c = RunClock()
    c.set(600.0, 0.0)
    _feed(c, 0.0, 30.0, True)
    c.set(300.0, 30.0)  # re-set at t=30 while RF is on: starts from zero now
    s = c.snapshot(30.0)
    assert s["target_s"] == 300.0 and s["on_s"] == pytest.approx(0.0, abs=0.01)


@pytest.mark.parametrize("bad", [0.0, -5.0, float("nan"), float("inf"), 24 * 3600 + 1.0])
def test_unreasonable_targets_are_rejected(bad):
    with pytest.raises(ValueError):
        RunClock().set(bad, 0.0)


def test_record_fields_for_the_csv():
    c = RunClock()
    assert c.record_fields(0.0) == {"clock_target_s": None, "clock_on_s": None}
    c.set(600.0, 0.0)
    _feed(c, 0.0, 10.5, True)
    r = c.record_fields(10.0)
    assert r["clock_target_s"] == 600.0 and r["clock_on_s"] == pytest.approx(10.0, abs=0.01)


def test_the_clock_has_no_way_to_command_anything():
    c = RunClock()
    assert not any(hasattr(c, n) for n in ("controller", "device", "disable_rf", "enable_rf"))


def test_a_gap_in_polls_is_not_counted_and_the_display_does_not_run_on():
    # link dropped / generator detached while RF was last seen on: that time is unknown, not RF-on
    from tc_power_interface.control.run_clock import STALE_S

    c = RunClock()
    c.set(600.0, 0.0)
    _feed(c, 0.0, 10.5, True)                     # last poll at t=10.0, RF on
    assert c.snapshot(10.0 + 60.0)["on_s"] <= 10.0 + STALE_S  # no polls for a minute: frozen
    c.update(70.0, True)                          # polls resume
    assert c.snapshot(70.0)["on_s"] == pytest.approx(10.0, abs=0.6)


def test_reset_link_forgets_the_rf_state_but_keeps_the_count():
    c = RunClock()
    c.set(600.0, 0.0)
    _feed(c, 0.0, 10.5, True)
    c.reset_link()
    s = c.snapshot(12.0)
    assert s["counting"] is False and s["on_s"] == pytest.approx(10.0, abs=0.6)
