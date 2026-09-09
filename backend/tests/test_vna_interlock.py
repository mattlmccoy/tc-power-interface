"""Safety-critical interlock: while a VNA (pre-run, RF-off) session is active, RF must be refused.

Invariants under test (fail-safe by construction):
- ``enable_rf`` is refused while a VNA session is active (the message maps to HTTP 409 upstream).
- ``begin_vna_session`` forces RF off best-effort (defense in depth).
- ``end_vna_session`` clears the session and RF is allowed again (arm/connected/not-faulted gates
  still apply).
- ``disable_rf`` and ``estop`` are NEVER gated by the session (RF-off / E-STOP always available).
- A stale heartbeat is REPORTED in the snapshot but must NOT clear the session — only ``end`` does.

Helper note: the controller boots armed + CONNECTED via ``connect()`` on a simulated CXN
(``CxnDevice(SimulatedCxnTransport())``), matching the real device API used across ``test_controller``;
telemetry is driven deterministically with ``_tick()`` (no background poll thread).
"""

import time

import pytest

from tc_power_interface.control.controller import Controller, ControllerState
from tc_power_interface.device.cxn import CxnDevice
from tc_power_interface.device.simulated import SimulatedCxnTransport


def _armed_controller() -> Controller:
    """An armed + CONNECTED controller on a simulated generator (no background poll)."""
    c = Controller(CxnDevice(SimulatedCxnTransport()), poll_interval_s=0.01)
    c.connect()  # request control + force MANUAL -> CONNECTED; armed stays True (boot default)
    assert c.armed is True
    assert c.state is ControllerState.CONNECTED
    return c


def test_enable_rf_refused_while_vna_session_active():
    c = _armed_controller()
    c.begin_vna_session()
    with pytest.raises(RuntimeError, match="VNA mode"):
        c.enable_rf()


def test_begin_forces_rf_off_best_effort():
    c = _armed_controller()
    c.enable_rf()  # RF on first
    c._tick()
    assert c.latest_telemetry.rf_on is True  # precondition: RF really on
    c.begin_vna_session()  # sets active, then best-effort disable_rf()
    c._tick()  # refresh telemetry after the forced-off
    assert c.snapshot()["telemetry"]["rf_on"] in (False, None)  # forced off


def test_end_clears_session_but_does_not_enable_rf():
    c = _armed_controller()
    c.begin_vna_session()
    c.end_vna_session()
    assert c.snapshot()["vna_session"]["active"] is False
    c.enable_rf()  # now allowed (no exception)


def test_estop_and_disable_rf_allowed_during_session():
    c = _armed_controller()
    c.begin_vna_session()
    c.disable_rf()  # must not raise — RF-off is never gated by the session
    c.estop()  # must not raise — E-STOP is never gated by the session


def test_stale_heartbeat_does_not_clear_session():
    c = _armed_controller()
    c.begin_vna_session()
    snap = c.snapshot()["vna_session"]
    assert snap["active"] is True and "stale" in snap and "age_s" in snap
    # Force the last heartbeat far into the past: staleness must be REPORTED but must NOT clear it.
    c._vna_hb_ns = time.monotonic_ns() - int((c._vna_stale_s + 5.0) * 1e9)
    stale = c.snapshot()["vna_session"]
    assert stale["stale"] is True  # reported
    assert stale["active"] is True  # but the session is NOT cleared — only end_vna_session() does
