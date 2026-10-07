"""Pure codec for Siglent SDS1000X-E waveform replies (no IO).

Scaling per the SDS1000X-E programming guide:
volts = code * VDIV/25 - OFST; time = -TDIV*14/2 + i/SARA.
Verified against real SDS1202X-E FW 1.3.27 replies 2026-10-07 (see tests/fixtures/scope/README.md).
"""

from __future__ import annotations

import re

import numpy as np
from numpy.typing import NDArray

GRID_DIVS = 14
CODES_PER_DIV = 25.0
ADC_MIN = -128
ADC_MAX = 127
_NUMBER = re.compile(r"^\s*([-+]?\d+(?:\.\d*)?(?:[eE][-+]?\d+)?)")


class ScopeCodecError(ValueError):
    """A scope reply could not be parsed."""


def parse_wf_block(raw: bytes) -> NDArray[np.int8]:
    """Extract the int8 sample codes from a ``WF? DAT2`` reply (``…#9<9-digit len><bytes>``)."""
    i = raw.find(b"#9")
    if i < 0:
        raise ScopeCodecError("no #9 block header in waveform reply")
    digits = raw[i + 2 : i + 11]
    if len(digits) != 9 or not digits.isdigit():
        raise ScopeCodecError("bad #9 block length")
    n = int(digits)
    data = raw[i + 11 : i + 11 + n]
    if len(data) != n:
        raise ScopeCodecError(f"short waveform block: {len(data)} of {n} bytes")
    return np.frombuffer(data, dtype=np.int8).copy()


def codes_to_volts(codes: NDArray[np.int8], *, vdiv: float, ofst: float) -> NDArray[np.float64]:
    return codes.astype(np.float64) * (vdiv / CODES_PER_DIV) - ofst


def time_axis(n: int, *, tdiv: float, sara: float) -> NDArray[np.float64]:
    return -tdiv * GRID_DIVS / 2 + np.arange(n, dtype=np.float64) / sara


def is_clipped(codes: NDArray[np.int8]) -> bool:
    return bool(np.any(codes <= ADC_MIN) or np.any(codes >= ADC_MAX))


def parse_number(reply: str) -> float:
    """Leading float of a CHDR-OFF reply, ignoring unit suffixes (``5.00E+01V``, ``1.00E+09Sa/s``).
    """
    m = _NUMBER.match(reply)
    if m is None:
        raise ScopeCodecError(f"non-numeric scope reply: {reply!r}")
    return float(m.group(1))
