"""Per-session HEURISTIC flags for poor clip seating and thermal detune. Not calibrated."""

from __future__ import annotations

import math
import statistics
from collections import deque
from dataclasses import dataclass, field

BASELINE_N = 5
SEATING_FACTOR = 3.0
DETUNE_WINDOW_S = 30.0
DETUNE_DROP = 0.05


@dataclass
class _LevelHistory:
    resid: list[float] = field(default_factory=list)
    h2: list[float] = field(default_factory=list)
    vps: deque[tuple[float, float]] = field(default_factory=deque)  # (t, Vrms/√W)


class SessionFlagger:
    """Stateful per-session flagger; keeps a separate history per power level."""

    def __init__(self) -> None:
        self._levels: dict[float, _LevelHistory] = {}

    def update(
        self, *, t_s: float, level_w: float | None, vrms_v: float, resid_v: float, h2_pct: float
    ) -> tuple[str, ...]:
        """Return heuristic flags ("seating", "detune") for one reading."""
        if level_w is None or level_w <= 0:
            return ()
        h = self._levels.setdefault(level_w, _LevelHistory())
        flags: list[str] = []
        if len(h.resid) >= BASELINE_N:
            if resid_v > SEATING_FACTOR * statistics.median(h.resid[:BASELINE_N]) or h2_pct > (
                SEATING_FACTOR * statistics.median(h.h2[:BASELINE_N])
            ):
                flags.append("seating")
        else:
            h.resid.append(resid_v)
            h.h2.append(h2_pct)
        vps = vrms_v / math.sqrt(level_w)
        h.vps.append((t_s, vps))
        while h.vps and t_s - h.vps[0][0] > DETUNE_WINDOW_S:
            h.vps.popleft()
        t0, v0 = h.vps[0]
        if t_s - t0 >= DETUNE_WINDOW_S - 1.0 and vps < (1 - DETUNE_DROP) * v0:
            flags.append("detune")
        return tuple(flags)
