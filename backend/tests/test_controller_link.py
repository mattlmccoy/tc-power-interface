"""Tests for the controller's display-only link block (GEN heartbeat source)."""

from __future__ import annotations

import pytest

from tc_power_interface.control.controller import Controller
from tc_power_interface.control.safety import SafetyLimits
from tc_power_interface.device.cxn import CxnDevice
from tc_power_interface.device.simulated import SimulatedCxnTransport


class _Clock:
    def __init__(self) -> None:
        self.t = 100.0

    def __call__(self) -> float:
        return self.t


def _make(clock: _Clock, link_loss_reads: int = 3) -> tuple[Controller, CxnDevice]:
    dev = CxnDevice(SimulatedCxnTransport())
    c = Controller(
        dev,
        limits=SafetyLimits(),
        poll_interval_s=0.01,
        clock=clock,
        link_loss_reads=link_loss_reads,
    )
    c.connect()
    return c, dev


def _lost() -> None:
    raise TimeoutError("serial read timed out: got 0 of 1 bytes")


def test_link_block_before_any_read() -> None:
    c, _ = _make(_Clock())
    assert c.snapshot()["link"] == {"poll_seq": 0, "last_ok_age_s": None, "read_failures": 0}


def test_poll_seq_increments_per_good_read_and_age_tracks_clock() -> None:
    clock = _Clock()
    c, _ = _make(clock)
    c._tick()
    c._tick()
    clock.t += 0.75
    link = c.snapshot()["link"]
    assert link["poll_seq"] == 2
    assert link["last_ok_age_s"] == pytest.approx(0.75)
    assert link["read_failures"] == 0


def test_read_failures_reported_and_seq_not_advanced() -> None:
    clock = _Clock()
    c, dev = _make(clock, link_loss_reads=5)
    c._tick()  # one good read, RF off -> later failures are a benign (debounced) idle link loss
    dev.read_telemetry = _lost  # type: ignore[method-assign, assignment]
    c._tick()
    c._tick()
    link = c.snapshot()["link"]
    assert link["poll_seq"] == 1
    assert link["read_failures"] == 2


def test_good_read_after_failure_clears_failures() -> None:
    clock = _Clock()
    c, dev = _make(clock, link_loss_reads=5)
    good = dev.read_telemetry
    dev.read_telemetry = _lost  # type: ignore[method-assign, assignment]
    c._tick()
    dev.read_telemetry = good  # type: ignore[method-assign]
    c._tick()
    link = c.snapshot()["link"]
    assert link["poll_seq"] == 1
    assert link["read_failures"] == 0
