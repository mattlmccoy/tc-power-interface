"""A stalled poll thread that outlives detach's join timeout must not be revived by a re-attach.

Regression for the 2026-10-07 safety review: _start_polling cleared a SHARED stop event, so an old
poll thread still alive after a timed-out join woke up and polled the NEW device alongside the new
thread (two pollers on the RF generator's serial link)."""

from __future__ import annotations

import threading
import time

from tc_power_interface.control.controller import Controller
from tc_power_interface.device.cxn import CxnDevice
from tc_power_interface.device.simulated import SimulatedCxnTransport


def test_reattach_after_timed_out_join_runs_exactly_one_poll_loop() -> None:
    c = Controller(device=None, poll_interval_s=0.01)
    old_thread: list[threading.Thread] = []
    stall = threading.Event()
    stalled = threading.Event()
    release = threading.Event()

    # Stall the OLD poll thread outside _io_lock (a listener, like the recorder's Dropbox-synced
    # csv flush) so detach_device's 2 s join times out while detach itself still completes. A hung
    # device read can't model this deterministically: it holds _io_lock, so detach would block in
    # _safe_shutdown_device until the read returned.
    def listener(_snap: dict) -> None:
        if stall.is_set() and threading.current_thread() is old_thread[0]:
            stalled.set()
            release.wait(10.0)

    c.add_listener(listener)
    c.attach_device(CxnDevice(SimulatedCxnTransport()))
    assert c._thread is not None
    old_thread.append(c._thread)
    stall.set()
    assert stalled.wait(2.0), "old poll thread never reached the stalled listener"

    c.detach_device()  # join(timeout=2.0) times out: the old thread is stuck in the listener
    assert old_thread[0].is_alive()

    new_dev = CxnDevice(SimulatedCxnTransport())
    readers: set[threading.Thread] = set()
    real_read = new_dev.read_telemetry

    def counting_read():  # type: ignore[no-untyped-def]
        readers.add(threading.current_thread())
        return real_read()

    new_dev.read_telemetry = counting_read  # type: ignore[method-assign]
    c.attach_device(new_dev)
    new_thread = c._thread
    try:
        release.set()  # unstick the old thread: it must exit, not start polling new_dev
        old_thread[0].join(1.0)
        time.sleep(0.2)  # ~20 poll intervals for any revived loop to show up
        assert not old_thread[0].is_alive(), "old poll thread was revived by the re-attach"
        assert readers == {new_thread}, f"new device polled by {len(readers)} threads"
    finally:
        release.set()
        c.stop()
