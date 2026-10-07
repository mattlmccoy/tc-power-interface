"""Tests for the pure RF on-time clock (current burn, last burn, RF-on total in the run)."""

from __future__ import annotations

import pytest

from tc_power_interface.control.rf_clock import RfClock


def test_fresh_clock_has_no_data() -> None:
    s = RfClock().snapshot(0.0, link_ok=True)
    assert s == {
        "rf_on": None,
        "burn_s": None,
        "last_burn_s": None,
        "run_rf_on_s": 0.0,
        "run": None,
        "stale": False,
        "known": False,
        "last_run_rf_on_s": None,
    }


def test_rising_edge_starts_burn_and_burn_grows_at_snapshot_time() -> None:
    c = RfClock()
    c.update(10.0, False, None)
    c.update(10.5, True, None)
    s = c.snapshot(12.0, link_ok=True)
    assert s["rf_on"] is True
    assert s["burn_s"] == pytest.approx(1.5)
    assert s["last_burn_s"] is None


def test_falling_edge_records_last_burn_and_clears_current() -> None:
    c = RfClock()
    c.update(0.0, True, None)
    c.update(4.0, True, None)
    c.update(5.0, False, None)
    s = c.snapshot(9.0, link_ok=True)
    assert s["rf_on"] is False
    assert s["burn_s"] is None
    assert s["last_burn_s"] == pytest.approx(5.0)


def test_run_accumulates_across_on_off_on_without_double_counting() -> None:
    c = RfClock()
    c.update(0.0, True, "runA")
    c.update(1.0, True, "runA")
    c.update(2.0, False, "runA")  # 2 s on
    c.update(5.0, False, "runA")  # off time not counted
    c.update(6.0, True, "runA")
    c.update(7.5, True, "runA")  # +1.5 s
    s = c.snapshot(7.5, link_ok=True)
    assert s["run_rf_on_s"] == pytest.approx(3.5)
    assert s["run"] == "runA"


def test_new_run_id_resets_run_total() -> None:
    c = RfClock()
    c.update(0.0, True, "runA")
    c.update(3.0, True, "runA")
    c.update(4.0, True, "runB")
    c.update(5.0, True, "runB")
    s = c.snapshot(5.0, link_ok=True)
    assert s["run"] == "runB"
    assert s["run_rf_on_s"] == pytest.approx(1.0)


def test_no_accumulation_while_not_recording() -> None:
    c = RfClock()
    c.update(0.0, True, None)
    c.update(10.0, True, None)
    s = c.snapshot(12.0, link_ok=True)
    assert s["run_rf_on_s"] == 0.0
    assert s["run"] is None
    assert s["burn_s"] == pytest.approx(12.0)  # the burn itself is still timed


def test_run_total_kept_after_recording_stops() -> None:
    c = RfClock()
    c.update(0.0, True, "runA")
    c.update(2.0, True, "runA")
    c.update(3.0, True, None)  # recording stopped: the 2->3 interval is not in a run
    s = c.snapshot(4.0, link_ok=True)
    assert s["run"] is None
    assert s["run_rf_on_s"] == pytest.approx(2.0)


def test_unknown_rf_state_neither_accumulates_nor_changes_edges() -> None:
    c = RfClock()
    c.update(0.0, True, "runA")
    c.update(1.0, None, "runA")  # no telemetry: no edge, no accumulation
    c.update(5.0, None, "runA")
    c.update(6.0, True, "runA")  # still the same burn (no falling edge was seen)
    s = c.snapshot(6.0, link_ok=True)
    assert s["burn_s"] == pytest.approx(6.0)
    assert s["last_burn_s"] is None
    assert s["run_rf_on_s"] == pytest.approx(0.0)
    assert s["rf_on"] is True


def test_snapshot_includes_partial_burn_since_last_update() -> None:
    c = RfClock()
    c.update(0.0, True, "runA")
    c.update(1.0, True, "runA")
    assert c.snapshot(1.3, link_ok=True)["run_rf_on_s"] == pytest.approx(1.3)
    assert c.snapshot(1.4, link_ok=True)["run_rf_on_s"] == pytest.approx(1.4)
    # the partial is display-only: the next update counts from the previous update, once
    c.update(1.5, True, "runA")
    assert c.snapshot(1.5, link_ok=True)["run_rf_on_s"] == pytest.approx(1.5)


def test_snapshot_partial_not_added_when_off_or_not_running() -> None:
    c = RfClock()
    c.update(0.0, True, "runA")
    c.update(1.0, False, "runA")
    assert c.snapshot(3.0, link_ok=True)["run_rf_on_s"] == pytest.approx(1.0)


def test_stale_flag_follows_link_ok() -> None:
    c = RfClock()
    c.update(0.0, True, None)
    assert c.snapshot(1.0, link_ok=False)["stale"] is True
    assert c.snapshot(1.0, link_ok=True)["stale"] is False


# --- known: RF state observed on the CURRENT device link ------------------------------------------


def test_known_after_first_sample_while_attached() -> None:
    c = RfClock()
    c.update(0.0, None, None)  # no telemetry yet
    assert c.snapshot(0.1, link_ok=False)["known"] is False
    c.update(0.5, False, None)
    assert c.snapshot(0.6, link_ok=True)["known"] is True


def test_not_known_when_no_device_attached() -> None:
    c = RfClock()
    c.update(0.0, True, None)
    assert c.snapshot(1.0, link_ok=False, attached=False)["known"] is False


def test_lost_link_while_known_stays_known_and_stale() -> None:
    c = RfClock()
    c.update(0.0, True, None)
    c.update(1.0, None, None)  # reads failing (e.g. faulted with RF on): device still attached
    s = c.snapshot(7.0, link_ok=False, attached=True)
    assert s["known"] is True
    assert s["stale"] is True


def test_reset_link_forgets_rf_state_but_keeps_history() -> None:
    c = RfClock()
    c.update(0.0, True, "runA")
    c.update(2.0, False, "runA")
    c.update(3.0, True, "runA")
    c.reset_link()  # detach / link drop: the next device starts unknown
    s = c.snapshot(4.0, link_ok=False)
    assert s["known"] is False
    assert s["rf_on"] is None
    assert s["burn_s"] is None
    assert s["last_burn_s"] == pytest.approx(2.0)
    c.update(5.0, True, "runA")  # first sample on the new link is a fresh rising edge
    assert c.snapshot(6.0, link_ok=True)["burn_s"] == pytest.approx(1.0)


# --- last run total after the recording stops -----------------------------------------------------


def test_last_run_total_shown_after_recording_stops() -> None:
    c = RfClock()
    c.update(0.0, True, "runA")
    c.update(2.0, False, "runA")  # 2 s on
    assert c.snapshot(2.5, link_ok=True)["last_run_rf_on_s"] is None  # still recording
    c.update(3.0, False, None)  # recording stopped
    s = c.snapshot(4.0, link_ok=True)
    assert s["run"] is None
    assert s["last_run_rf_on_s"] == pytest.approx(2.0)
    c.update(5.0, False, None)
    assert c.snapshot(5.0, link_ok=True)["last_run_rf_on_s"] == pytest.approx(2.0)


def test_last_run_total_cleared_when_rf_turns_on_again() -> None:
    c = RfClock()
    c.update(0.0, True, "runA")
    c.update(2.0, False, "runA")
    c.update(3.0, False, None)
    c.update(4.0, True, None)  # rising edge
    assert c.snapshot(4.5, link_ok=True)["last_run_rf_on_s"] is None


def test_last_run_total_cleared_when_new_run_starts() -> None:
    c = RfClock()
    c.update(0.0, True, "runA")
    c.update(2.0, False, "runA")
    c.update(3.0, False, None)
    c.update(4.0, False, "runB")
    s = c.snapshot(4.5, link_ok=True)
    assert s["last_run_rf_on_s"] is None
    assert s["run"] == "runB"
