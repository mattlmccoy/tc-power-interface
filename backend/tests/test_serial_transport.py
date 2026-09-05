"""Tests for the real serial transport mechanics using pyserial's in-memory loop:// port.

This validates read-exactly-N and timeout behaviour without any hardware. End-to-end behaviour
against a physical generator is a hardware-only concern (there is no device on loop://).
"""

import pytest

from tc_power_interface.device import create_transport


def test_serial_loopback_reads_exactly_n():
    t = create_transport("serial", port="loop://", timeout=0.2)
    try:
        t.write(b"hello")
        assert t.read(5) == b"hello"
    finally:
        t.close()


def test_serial_read_timeout_raises_when_underfilled():
    t = create_transport("serial", port="loop://", timeout=0.05)
    try:
        with pytest.raises(TimeoutError):
            t.read(4)  # nothing written -> short read -> timeout
    finally:
        t.close()
