import time

import pytest
from scope_fakes import FakeScope

from tc_power_interface.integration.scope_link import ScopeLink, acquire_once
from tc_power_interface.integration.scope_settings import (
    ScopeSettings,
    load_settings,
    save_settings,
)


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
