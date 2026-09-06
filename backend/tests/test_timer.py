"""Tests for the auto-shutoff TIMER: after N minutes (1-99, per the AG Plasma manual) the timer
commands RF off exactly once. It only ever *disables* RF; it never enables it."""

from tc_power_interface.control.timer import TimerController, TimerPlan


def test_plan_bounded_clamps_minutes():
    assert TimerPlan.bounded(minutes=0).minutes == 1
    assert TimerPlan.bounded(minutes=999).minutes == 99
    assert TimerPlan.bounded(minutes=30).minutes == 30


class FakeController:
    def __init__(self) -> None:
        self.disabled = 0
        self.enabled = 0

    def disable_rf(self) -> None:
        self.disabled += 1

    def enable_rf(self) -> None:  # must never be called by the timer
        self.enabled += 1


def test_timer_disables_rf_after_elapsed_once():
    fake = FakeController()
    tc = TimerController(fake, plan=TimerPlan(minutes=1))
    tc.start()
    for _ in range(59):  # 59 s — not yet
        tc.tick(1.0)
    assert fake.disabled == 0
    assert tc.snapshot()["done"] is False

    tc.tick(1.0)  # cross 60 s
    assert fake.disabled == 1
    assert tc.snapshot()["done"] is True

    for _ in range(5):  # further ticks must not re-fire
        tc.tick(1.0)
    assert fake.disabled == 1


def test_timer_never_enables_rf():
    fake = FakeController()
    tc = TimerController(fake, plan=TimerPlan(minutes=1))
    tc.start()
    for _ in range(120):
        tc.tick(1.0)
    assert fake.enabled == 0


def test_stopped_timer_does_not_fire():
    fake = FakeController()
    tc = TimerController(fake, plan=TimerPlan(minutes=1))
    for _ in range(120):  # never started
        tc.tick(1.0)
    assert fake.disabled == 0


def test_snapshot_reports_remaining():
    fake = FakeController()
    tc = TimerController(fake, plan=TimerPlan(minutes=1))
    tc.start()
    for _ in range(30):
        tc.tick(1.0)
    snap = tc.snapshot()
    assert snap["running"] is True
    assert snap["minutes"] == 1
    assert round(snap["elapsed_s"]) == 30
    assert round(snap["remaining_s"]) == 30
