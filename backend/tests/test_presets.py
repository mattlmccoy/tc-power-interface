"""Tests for software tuner-cap PRESETS: 9 slots of {tune%, load%}. Recall applies the stored caps
in MANUAL (MTUNE) mode — never the generator's forbidden ATUNE preset path."""

import pytest

from tc_power_interface.control.presets import PresetStore


class FakeController:
    def __init__(self) -> None:
        self.calls: list[tuple[str, object]] = []

    def set_manual_mode(self, on: bool) -> None:
        self.calls.append(("manual", on))

    def set_tune_capacity(self, p: int) -> None:
        self.calls.append(("tune", p))

    def set_load_capacity(self, p: int) -> None:
        self.calls.append(("load", p))


def test_save_and_list(tmp_path):
    s = PresetStore(tmp_path)
    s.save(3, tune=42, load=61)
    lst = s.list()
    assert lst[3] == {"tune_cap_percent": 42, "load_cap_percent": 61}
    assert lst[1] is None


def test_recall_applies_caps_in_manual_mode_first(tmp_path):
    s = PresetStore(tmp_path)
    s.save(2, tune=40, load=60)
    fake = FakeController()
    applied = s.recall(2, fake)
    assert applied == {"tune_cap_percent": 40, "load_cap_percent": 60}
    # manual mode set FIRST (never ATUNE), then caps
    assert fake.calls == [("manual", True), ("tune", 40), ("load", 60)]


def test_recall_empty_slot_is_noop(tmp_path):
    s = PresetStore(tmp_path)
    fake = FakeController()
    assert s.recall(5, fake) is None
    assert fake.calls == []


def test_save_clamps_caps_and_rejects_bad_slot(tmp_path):
    s = PresetStore(tmp_path)
    s.save(1, tune=150, load=-10)
    assert s.list()[1] == {"tune_cap_percent": 100, "load_cap_percent": 0}
    with pytest.raises(ValueError):
        s.save(0, tune=10, load=10)
    with pytest.raises(ValueError):
        s.save(10, tune=10, load=10)


def test_persists_across_instances(tmp_path):
    PresetStore(tmp_path).save(7, tune=33, load=44)
    assert PresetStore(tmp_path).list()[7] == {"tune_cap_percent": 33, "load_cap_percent": 44}


def test_clear(tmp_path):
    s = PresetStore(tmp_path)
    s.save(4, tune=10, load=20)
    s.clear(4)
    assert s.list()[4] is None
