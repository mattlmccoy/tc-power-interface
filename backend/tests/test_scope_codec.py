"""Scope codec tests.

Verified against real SDS1202X-E FW 1.3.27 replies 2026-10-07.
"""

import csv
import json
from pathlib import Path

import numpy as np
import pytest

from tc_power_interface.analysis.flux import LoopGeometry, b_pk_mt
from tc_power_interface.analysis.sense_loop_fit import fit_sense_loop
from tc_power_interface.integration.scope_codec import (
    ScopeCodecError,
    codes_to_volts,
    is_clipped,
    parse_number,
    parse_wf_block,
    time_axis,
)

FIX = Path(__file__).parent / "fixtures" / "scope"


def _block(codes: list[int]) -> bytes:
    payload = np.array(codes, dtype=np.int8).tobytes()
    return b"C1:WF DAT2,#9" + f"{len(payload):09d}".encode() + payload + b"\n\n"


def test_parse_wf_block_returns_int8_codes():
    out = parse_wf_block(_block([0, 1, -1, 127, -128]))
    assert out.dtype == np.int8
    assert out.tolist() == [0, 1, -1, 127, -128]


def test_parse_wf_block_rejects_missing_header():
    with pytest.raises(ScopeCodecError, match="#9"):
        parse_wf_block(b"garbage")


def test_parse_wf_block_rejects_short_payload():
    raw = b"#9000000010" + b"\x01\x02"
    with pytest.raises(ScopeCodecError, match="short"):
        parse_wf_block(raw)


def test_scaling_matches_real_50w_capture_grid():
    # Real capture: 50 V/div, offset -6 V. Steps are VDIV/25 = 2 V;
    # the CSV export adds ~0.1 V jitter.
    volts = []
    for row in csv.reader((FIX / "core2_50W_SDS00006.csv").open()):
        try:
            volts.append(float(row[1]))
        except (ValueError, IndexError):
            continue
    v = np.array(volts)
    codes = np.round((v - 6.0) / 2.0).astype(np.int8)
    np.testing.assert_allclose(codes_to_volts(codes, vdiv=50.0, ofst=-6.0), v, atol=0.11)


def test_time_axis_centres_on_14_divisions():
    t = time_axis(1400, tdiv=1e-7, sara=1e9)
    assert t[0] == pytest.approx(-7e-7)
    assert t[1] - t[0] == pytest.approx(1e-9)


def test_is_clipped_only_at_rails():
    assert not is_clipped(np.array([-127, 0, 126], dtype=np.int8))
    assert is_clipped(np.array([0, 127], dtype=np.int8))
    assert is_clipped(np.array([-128, 0], dtype=np.int8))


@pytest.mark.parametrize(
    ("reply", "value"),
    [
        ("5.00E+01", 50.0),
        ("5.00E+01V", 50.0),
        ("1.00E+09Sa/s", 1e9),
        ("-6.00E+00V\n", -6.0),
        ("50", 50.0),
    ],
)
def test_parse_number_strips_units(reply, value):
    assert parse_number(reply) == pytest.approx(value)


def test_parse_number_rejects_non_numeric():
    with pytest.raises(ScopeCodecError):
        parse_number("ERR")


@pytest.mark.parametrize("header", [b"#9 00000003", b"#9-00000003", b"#9+0000003x", b"#90000000 3"])
def test_parse_wf_block_rejects_non_digit_length(header):
    with pytest.raises(ScopeCodecError, match="bad #9 block length"):
        parse_wf_block(header + b"abc")


# --- real replies: SDS1202X-E FW 1.3.27 over LAN, 10 W RF on, captured 2026-10-07 ---
REAL = FIX / "scope_replies_20261007_10W"


def _real_replies() -> dict[str, str]:
    return json.loads((REAL / "replies.json").read_text())


def _real_codes(i: int) -> np.ndarray:
    return parse_wf_block((REAL / f"wf_{i}.bin").read_bytes())


def _real_volts(i: int) -> np.ndarray:
    r = _real_replies()
    return codes_to_volts(
        _real_codes(i), vdiv=parse_number(r["C1:VDIV?"]), ofst=parse_number(r["C1:OFST?"])
    )


def _panel_volts() -> np.ndarray:
    vals, in_data = [], False
    for row in csv.reader((REAL / "front_panel.csv").open()):
        if in_data:
            vals.append(float(row[1]))
        elif row and row[0] == "Second":
            in_data = True
    return np.array(vals)


def _fit_vrms(t: np.ndarray, v: np.ndarray) -> float:
    return fit_sense_loop(t, v).vrms_v


def _real_t() -> np.ndarray:
    r = _real_replies()
    return time_axis(1400, tdiv=parse_number(r["TDIV?"]), sara=parse_number(r["SARA?"]))


@pytest.mark.parametrize("i", range(10))
def test_real_wf_blocks_parse_unclipped(i):
    codes = _real_codes(i)
    assert codes.dtype == np.int8
    assert len(codes) == 1400
    assert not is_clipped(codes)


def test_real_replies_all_parse_numbers():
    r = _real_replies()
    nums = {k: parse_number(v) for k, v in r.items() if k != "*IDN?" and k != "TRMD?"}
    assert nums == {
        "C1:ATTN?": 500.0, "C1:VDIV?": 50.0, "C1:OFST?": -6.0, "TDIV?": 1e-7, "SARA?": 1e9,
    }
    with pytest.raises(ScopeCodecError):
        parse_number(r["TRMD?"])


def test_real_visa_volts_lie_on_front_panel_value_grid():
    visa = {round(float(x), 2) for x in _real_volts(0)}
    panel = {round(float(x), 2) for x in _panel_volts()}
    assert len(panel) > 30
    assert panel <= visa


def test_real_front_panel_vrms_matches_visa_median():
    t = _real_t()
    visa = float(np.median([_fit_vrms(t, _real_volts(i)) for i in range(10)]))
    panel = _fit_vrms(t, _panel_volts())
    assert panel == pytest.approx(visa, rel=0.01)


def test_real_median_b_pk_in_expected_range():
    t = _real_t()
    fits = [fit_sense_loop(t, _real_volts(i)) for i in range(10)]
    b = float(np.median([b_pk_mt(f.vrms_v, f.f0_hz, LoopGeometry()) for f in fits]))
    assert 2.7 <= b <= 2.95
