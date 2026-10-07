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


def _tick_in_flight_during_detach(*, read_raises: bool) -> tuple[Controller, list, list]:
    """Run one _tick whose device read is hung (holding _io_lock) while the operator detaches.

    detach_device starts on another thread and then blocks on _io_lock in _safe_shutdown_device;
    only then does the hung read complete (return or raise). Returns the controller plus the
    listener snapshots and on_link_dropped calls produced AFTER the read completed."""
    dev = CxnDevice(SimulatedCxnTransport())
    c = Controller(dev, poll_interval_s=0.01, link_loss_reads=1)
    c.connect()
    gate = threading.Event()
    in_read = threading.Event()
    real_read = dev.read_telemetry

    def hung_read():  # type: ignore[no-untyped-def]
        in_read.set()
        gate.wait(10.0)
        if read_raises:
            raise TimeoutError("serial read timed out: got 0 of 1 bytes")
        return real_read()

    dev.read_telemetry = hung_read  # type: ignore[method-assign]
    notified: list = []
    dropped: list = []
    c.add_listener(notified.append)
    c.on_link_dropped = lambda: dropped.append(True)

    ticker = threading.Thread(target=c._tick)
    ticker.start()
    assert in_read.wait(2.0)
    detacher = threading.Thread(target=c.detach_device)
    detacher.start()
    time.sleep(0.2)  # detacher is now past its start and blocked on _io_lock behind the read
    gate.set()
    ticker.join(5.0)
    detacher.join(5.0)
    assert not ticker.is_alive() and not detacher.is_alive()
    return c, notified, dropped


def test_tick_whose_read_returns_after_detach_publishes_nothing() -> None:
    c, notified, _ = _tick_in_flight_during_detach(read_raises=False)
    assert notified == [], "a stale tick published a sample from a link that was being detached"
    assert c.latest_telemetry is None


def test_tick_whose_read_fails_after_detach_does_not_drop_the_link() -> None:
    c, notified, dropped = _tick_in_flight_during_detach(read_raises=True)
    assert dropped == [], "a stale tick ran link-loss handling on a link already being detached"
    assert notified == []


def test_polling_follows_the_current_poll_thread_not_a_stalled_old_one() -> None:
    """The idle observer keys off ``polling``. A stalled old poll thread that outlived detach's
    join timeout is still alive but told to stop: it must not read as a live loop, and a re-attach
    beside it must read as live (the new thread with its own unset stop event)."""
    c = Controller(device=None, poll_interval_s=0.01)
    old_thread: list[threading.Thread] = []
    stall = threading.Event()
    stalled = threading.Event()
    release = threading.Event()

    def listener(_snap: dict) -> None:
        if stall.is_set() and threading.current_thread() is old_thread[0]:
            stalled.set()
            release.wait(10.0)

    c.add_listener(listener)
    c.attach_device(CxnDevice(SimulatedCxnTransport()))
    assert c.polling is True
    assert c._thread is not None
    old_thread.append(c._thread)
    stall.set()
    assert stalled.wait(2.0)
    try:
        c.detach_device()  # join times out: the old thread is alive, stuck in the listener
        assert old_thread[0].is_alive()
        assert c.polling is False, "a stalled, stopped poll thread read as a live poll loop"
        c.attach_device(CxnDevice(SimulatedCxnTransport()))
        assert c.polling is True
        release.set()
        old_thread[0].join(1.0)
        assert c.polling is True  # the old thread exiting does not end the new loop
        c.detach_device()
        assert c.polling is False
    finally:
        release.set()
        c.stop()


def test_stale_drop_link_does_not_kill_a_reattached_link() -> None:
    """An old poll thread that passed its link-gen check on a failed read, then lost the CPU while
    the operator detached and re-attached, must not tear down the NEW link when it resumes.

    Regression for the 2026-10-07 cockpit merge review: _drop_link set the SHARED ``_stop`` (the
    new poll thread's event) and cleared ``device``, so the generator stayed live while the
    operator showed DISCONNECTED."""
    c = Controller(device=None, poll_interval_s=0.01, link_loss_reads=1)
    old_dev = CxnDevice(SimulatedCxnTransport())
    fail = threading.Event()
    real_old_read = old_dev.read_telemetry

    def failing_read():  # type: ignore[no-untyped-def]
        if fail.is_set():
            raise TimeoutError("serial read timed out: got 0 of 1 bytes")
        return real_old_read()

    old_dev.read_telemetry = failing_read  # type: ignore[method-assign]
    dropped: list[bool] = []
    c.on_link_dropped = lambda: dropped.append(True)
    c.attach_device(old_dev)
    old_thread = c._thread
    assert old_thread is not None

    # Pause the old thread in the window between _tick's post-read link-gen check and
    # _on_read_failure -> _drop_link. _record_read_outcome is the first call after that check on
    # the read-failure path; there is no device-side hook inside an in-memory window.
    paused = threading.Event()
    release = threading.Event()
    real_record = c._record_read_outcome

    def pausing_record(*, invalid: bool) -> None:
        if threading.current_thread() is old_thread and fail.is_set() and not paused.is_set():
            paused.set()
            release.wait(10.0)
        real_record(invalid=invalid)

    c._record_read_outcome = pausing_record  # type: ignore[method-assign]
    fail.set()
    assert paused.wait(2.0), "old poll thread never reached the post-check window"

    try:
        c.detach_device()  # join times out: the old thread is paused inside its tick
        new_dev = CxnDevice(SimulatedCxnTransport())
        reads = [0]
        real_new_read = new_dev.read_telemetry

        def counting_read():  # type: ignore[no-untyped-def]
            reads[0] += 1
            return real_new_read()

        new_dev.read_telemetry = counting_read  # type: ignore[method-assign]
        c.attach_device(new_dev)
        new_thread = c._thread
        assert c.polling is True

        release.set()  # the old thread resumes: _on_read_failure -> _drop_link on a stale link
        old_thread.join(2.0)
        assert not old_thread.is_alive()
        before = reads[0]
        time.sleep(0.2)
        assert c.device is new_dev, "a stale _drop_link detached the freshly attached device"
        assert c._thread is new_thread and new_thread is not None and new_thread.is_alive()
        assert c.polling is True, "a stale _drop_link stopped the new poll thread"
        assert reads[0] > before, "the new poll thread stopped polling"
        assert c.state.value == "connected"
        assert dropped == [], "on_link_dropped fired for a link that was already replaced"
    finally:
        release.set()
        c.stop()
