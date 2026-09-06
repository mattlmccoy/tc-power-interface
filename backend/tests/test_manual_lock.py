"""Safety: the built-in auto-tuner (ATUNE) must NEVER be engaged by our software.

The CXN tuner-mode command is TM 02 (manual) / TM 01 (automatic). Our stack only ever emits the
MANUAL command; connect() forces manual; and there is no code path that can request automatic.
"""

from tc_power_interface.control.controller import Controller
from tc_power_interface.protocol import codec


def test_codec_has_manual_only_command():
    # The manual command is TM 02; the codec exposes no automatic (TM 01) command at all.
    assert codec.cmd_manual_mode() == b"TM\x00\x02\x00\x00"
    assert not hasattr(codec, "cmd_automatic_mode")


class RecordingDevice:
    """Minimal device stub recording control + manual calls."""

    def __init__(self) -> None:
        self.manual_calls = 0
        self.control = 0

    def request_control(self) -> bool:
        self.control += 1
        return True

    def force_manual_mode(self) -> None:
        self.manual_calls += 1


def test_controller_forces_manual_on_connect():
    dev = RecordingDevice()
    Controller(dev).connect()
    assert dev.manual_calls == 1


def test_controller_set_manual_false_never_sends_automatic():
    dev = RecordingDevice()
    c = Controller(dev)
    c.connect()
    c.set_manual_mode(False)  # attempt to leave manual -> must be ignored, forced back to manual
    assert dev.manual_calls == 2  # forced manual again; automatic is impossible
