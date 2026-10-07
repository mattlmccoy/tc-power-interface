import csv
import time
from pathlib import Path

import numpy as np
import pytest

from tc_power_interface.integration.scope_link import ScopeLink, acquire_once
from tc_power_interface.integration.scope_settings import (
    ScopeSettings,
    load_settings,
    save_settings,
)

FIX = Path(__file__).parent / "fixtures" / "scope"


def _real_codes() -> bytes:
    v = []
    in_data = False
    for row in csv.reader((FIX / "core2_50W_SDS00006.csv").open()):
        if row[:1] == ["Second"]:  # header rows above this (e.g. Horizontal Scale) parse as floats
            in_data = True
            continue
        if not in_data:
            continue
        try:
            v.append(float(row[1]))
        except (ValueError, IndexError):
            continue
    codes = np.round((np.array(v) - 6.0) / 2.0).astype(np.int8).tobytes()  # 50 V/div, offset -6 V
    return b"C1:WF DAT2,#9" + f"{len(codes):09d}".encode() + codes + b"\n\n"


class FakeScope:
    def __init__(self, fail_after: int | None = None) -> None:
        self.replies = {"C1:ATTN?": "50", "C1:VDIV?": "5.00E+01V", "C1:OFST?": "-6.00E+00V",
                        "TDIV?": "1.00E-07S", "SARA?": "1.00E+09Sa/s"}
        self.writes: list[str] = []
        self.reads = 0
        self.fail_after = fail_after
        self.closed = False

    def write(self, cmd: str) -> int:
        self.writes.append(cmd)
        return len(cmd)

    def query(self, cmd: str) -> str:
        return self.replies[cmd]

    def read_raw(self) -> bytes:
        self.reads += 1
        if self.fail_after is not None and self.reads > self.fail_after:
            raise OSError("usb stall")
        return _real_codes()

    def close(self) -> None:
        self.closed = True


def test_acquire_once_reproduces_real_capture():
    cap = acquire_once(FakeScope(), channel=1)
    assert (cap.attn, cap.vdiv, cap.ofst, cap.sara) == (50.0, 50.0, -6.0, 1e9)
    assert len(cap.volts) == 1400 and not cap.clipped
    assert cap.volts.min() == pytest.approx(-70.0) and cap.volts.max() == pytest.approx(72.0)


def test_never_writes_settings_to_the_scope():
    fake = FakeScope()
    acquire_once(fake, channel=1)
    forbidden = ("VDIV ", "TDIV ", "OFST ", "TRMD", "ATTN ")
    assert not any(w.startswith(f) or f" {f}" in w for w in fake.writes for f in forbidden)


def test_link_produces_readings_and_reports_errors_without_raising():
    got = []
    fake = FakeScope(fail_after=2)
    link = ScopeLink(opener=lambda _r: fake, on_reading=got.append, backoff_s=0.05)
    link.start(ScopeSettings(resource="USB0::fake", poll_interval_s=0.01))
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline and link.status()["error"] is None:
        time.sleep(0.01)
    link.stop()
    assert fake.writes[0] == "CHDR OFF"
    assert len(got) >= 2
    assert got[0].fit.vrms_v == pytest.approx(50.149, rel=1e-3)
    assert "usb stall" in (link.status()["error"] or "")


def test_rf_off_zero_capture_is_invalid_reading_not_link_error():
    got = []
    fake = FakeScope()
    fake.read_raw = lambda: b"#9000001400" + bytes(1400)  # all-zero codes, as with RF off
    link = ScopeLink(opener=lambda _r: fake, on_reading=got.append, backoff_s=0.05)
    link.start(ScopeSettings(resource="USB0::fake", poll_interval_s=0.01))
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline and len(got) < 3:
        time.sleep(0.01)
    link.stop()
    assert len(got) >= 3 and all(r.fit is None for r in got)
    assert link.status()["error"] is None


def test_settings_roundtrip_and_defaults(tmp_path):
    s = load_settings(tmp_path)
    assert s.resource == "" and s.geometry.cores_linked == 1 and s.tol_w == 1.0
    save_settings(tmp_path, ScopeSettings(resource="TCPIP0::1.2.3.4::INSTR", core_label="core 1"))
    s2 = load_settings(tmp_path)
    assert s2.resource == "TCPIP0::1.2.3.4::INSTR" and s2.core_label == "core 1"


def test_settings_from_dict_rejects_bad_limits():
    from tc_power_interface.integration.scope_settings import settings_from_dict

    with pytest.raises(ValueError):
        settings_from_dict({"limits": {"probe_warn_v": 80.0, "probe_hard_v": 70.0}})
