"""Scope codec tests. Block tests are SHAPE-ONLY until Task 12 captures real WF? replies."""

import csv
from pathlib import Path

import numpy as np
import pytest

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
