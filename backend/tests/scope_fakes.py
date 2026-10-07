"""Shared scope test doubles built from a real 50 W SDS1202X-E capture (fixtures/scope/)."""

import csv
from pathlib import Path

import numpy as np

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
