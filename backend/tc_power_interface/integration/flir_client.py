"""Client for the FLIR Research Interface thermal stream (``/ws/frames``).

The FLIR frame message is ``[4-byte big-endian header length][UTF-8 JSON header][raw counts]``
(see the FLIR ``api/frames.py`` wire format). For closed-loop control we only need the JSON
header, which carries server-computed statistics (e.g. ``center_c``, ``mean_c``, ``max_c``) with
over-range pixels already excluded. The raw counts payload is ignored here.

The header parsing is pure and unit-tested. :func:`stream_control_temperature` is a thin async
consumer that requires a running FLIR backend; it yields a chosen control-ROI temperature and is
the input a future thermal loop would feed to :mod:`tc_power_interface.control.thermal`.
"""

from __future__ import annotations

import json
import struct
from collections.abc import AsyncIterator
from typing import Any


def parse_flir_header(message: bytes) -> dict[str, Any]:
    """Parse the JSON header out of a FLIR frame message, ignoring the counts payload."""
    if len(message) < 4:
        raise ValueError("FLIR message too short for a header-length prefix")
    header_len = struct.unpack(">I", message[:4])[0]
    header_bytes = message[4 : 4 + header_len]
    if len(header_bytes) != header_len:
        raise ValueError("FLIR message truncated: header shorter than its declared length")
    parsed: dict[str, Any] = json.loads(header_bytes)
    return parsed


def control_temperature(message: bytes, stat: str = "center_c") -> float:
    """Return one temperature statistic (default the center ROI) from a FLIR frame message."""
    header = parse_flir_header(message)
    if stat not in header:
        raise KeyError(f"FLIR header has no stat {stat!r}; available: {sorted(header)}")
    return float(header[stat])


async def stream_control_temperature(
    url: str, stat: str = "center_c"
) -> AsyncIterator[float]:  # pragma: no cover - requires a live FLIR backend
    """Yield the chosen control-ROI temperature from a live FLIR ``/ws/frames`` stream.

    Requires the FLIR Research Interface to be running and acquiring. Import of ``websockets`` is
    local so this module has no import-time dependency on a running FLIR backend.
    """
    import websockets

    async with websockets.connect(url, max_size=None) as ws:
        async for message in ws:
            if isinstance(message, bytes):
                try:
                    yield control_temperature(message, stat=stat)
                except (ValueError, KeyError):
                    continue
